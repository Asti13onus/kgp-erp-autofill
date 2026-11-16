/*
 * shared.js — helpers used by the content script, popup and options page.
 *  - question matching (normalize + word-overlap fuzzy match)
 *  - AES-GCM / PBKDF2 encryption helpers (Web Crypto API)
 *  - chrome.storage helpers (local only; session for the unlocked copy)
 *
 * No network access of any kind.
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'kgpErpAutofill'; // chrome.storage.local
  const SESSION_KEY = 'kgpErpUnlocked'; // chrome.storage.session (memory only)
  const PBKDF2_ITERATIONS = 600000;
  const MATCH_THRESHOLD = 0.6; // minimum Dice score to accept a match
  const MATCH_MARGIN = 0.1; // best must beat the runner-up by this much

  // ---------------------------------------------------------------- matching

  const STOPWORDS = new Set([
    'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'how',
    'is', 'are', 'was', 'were', 'be', 'did', 'do', 'does',
    'your', 'you', 'my', 'me', 'i', 'the', 'a', 'an', 'of', 'in', 'on',
    'at', 'to', 'for', 'and', 'or', 'it', 'this', 'that',
    'question', 'security', 'please', 'enter', 'answer'
  ]);

  /** lowercase, drop apostrophes, turn other punctuation into spaces. */
  function normalizeQuestion(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/['’`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function stem(word) {
    return word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1)
      : word;
  }

  function tokenize(text) {
    const all = normalizeQuestion(text).split(' ').filter(Boolean).map(stem);
    const content = all.filter((w) => !STOPWORDS.has(w));
    return new Set(content.length ? content : all);
  }

  /** Dice coefficient over the two token sets, 0..1. */
  function similarity(a, b) {
    const A = tokenize(a);
    const B = tokenize(b);
    if (!A.size || !B.size) return 0;
    // A single shared word ("name") is far too weak to call a match.
    if (A.size < 2 || B.size < 2) {
      return A.size === B.size && [...A].every((w) => B.has(w)) ? 1 : 0;
    }
    let common = 0;
    for (const w of A) if (B.has(w)) common++;
    return (2 * common) / (A.size + B.size);
  }

  /**
   * Find the stored pair whose question best matches `question`.
   * Returns { pair, score } or null when there is no confident match
   * (below threshold, or too close to a different candidate).
   */
  function bestMatch(question, pairs) {
    const scored = (pairs || [])
      .filter((p) => p && p.q && p.a)
      .map((pair) => ({ pair, score: similarity(question, pair.q) }))
      .sort((x, y) => y.score - x.score);
    if (!scored.length) return null;
    const best = scored[0];
    const second = scored[1] ? scored[1].score : 0;
    if (best.score < MATCH_THRESHOLD) return null;
    if (best.score < 1 && best.score - second < MATCH_MARGIN) return null;
    return best;
  }

  // ------------------------------------------------------------------ crypto

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function toB64(buffer) {
    const bytes = new Uint8Array(buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function fromB64(str) {
    const s = atob(str);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  async function deriveKey(pin, salt, iterations) {
    const base = await crypto.subtle.importKey(
      'raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /** Encrypt a JSON-serialisable object with a PIN. Returns a storable record. */
  async function encryptData(data, pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt, PBKDF2_ITERATIONS);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(data))
    );
    return {
      v: 1,
      encrypted: true,
      kdf: { salt: toB64(salt), iter: PBKDF2_ITERATIONS },
      iv: toB64(iv),
      ct: toB64(ct)
    };
  }

  /** Decrypt a record made by encryptData. Throws Error('Wrong PIN') on failure. */
  async function decryptData(record, pin) {
    try {
      const key = await deriveKey(pin, fromB64(record.kdf.salt), record.kdf.iter);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromB64(record.iv) }, key, fromB64(record.ct)
      );
      return JSON.parse(decoder.decode(pt));
    } catch (e) {
      throw new Error('Wrong PIN');
    }
  }

  // ----------------------------------------------------------------- storage

  async function loadRecord() {
    const o = await chrome.storage.local.get(STORAGE_KEY);
    return o[STORAGE_KEY] || null;
  }

  async function saveRecord(record) {
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
  }

  /** Decrypted copy held in memory for this browser session (null if locked). */
  async function loadUnlocked() {
    try {
      const o = await chrome.storage.session.get(SESSION_KEY);
      return o[SESSION_KEY] || null;
    } catch (e) {
      return null; // session area not readable from this context yet
    }
  }

  async function setUnlocked(data) {
    // Lets the content script (an "untrusted" context) read the in-memory copy.
    await chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
    });
    await chrome.storage.session.set({ [SESSION_KEY]: data });
  }

  async function lock() {
    try { await chrome.storage.session.remove(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  async function clearAll() {
    await chrome.storage.local.remove(STORAGE_KEY);
    await lock();
  }

  root.KGP = {
    STORAGE_KEY, SESSION_KEY, PBKDF2_ITERATIONS, MATCH_THRESHOLD,
    normalizeQuestion, tokenize, similarity, bestMatch,
    encryptData, decryptData,
    loadRecord, saveRecord, loadUnlocked, setUnlocked, lock, clearAll
  };
})(globalThis);
