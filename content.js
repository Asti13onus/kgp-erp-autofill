/*
 * content.js — runs on https://erp.iitkgp.ac.in
 *
 * Fills the user's own saved roll number / password / security-question answer.
 * Never fills the OTP (it only focuses the field) and never submits a form.
 * Makes no network requests.
 */
(() => {
  'use strict';

  const K = globalThis.KGP;
  if (!K) return;

  const DOT_ATTR = 'data-kgp-autofill-dot';
  const DEBOUNCE_MS = 400;

  const autoFilled = new WeakSet(); // inputs we already filled once
  const otpFocused = new WeakSet(); // OTP inputs we already focused once
  const dots = new Map(); // input -> dot element

  // ---------------------------------------------------------------- helpers

  function isVisible(el) {
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function isOtp(el) {
    const hay = `${el.name} ${el.id} ${el.placeholder}`;
    return /otp/i.test(hay) || el.autocomplete === 'one-time-code';
  }

  const INLINE_TAGS = /^(B|I|U|EM|STRONG|SPAN|FONT|A|SMALL|SUB|SUP|MARK)$/;
  const TEXTLIKE = new Set(['text', 'number', 'tel', 'email', 'search']);

  function isUsable(el) {
    return !el.disabled && !el.readOnly && isVisible(el);
  }

  function isEmpty(el) {
    return el.value === '';
  }

  /** Set a value the way a user would, so frameworks notice it. */
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ------------------------------------------------------------- indicators

  const DOT_COLORS = { filled: '#2e9e4f', nomatch: '#e0a100', locked: '#8a8f98' };

  function setDot(input, state, title) {
    let dot = dots.get(input);
    if (!dot) {
      dot = document.createElement('div');
      dot.setAttribute(DOT_ATTR, '');
      dot.style.cssText =
        'position:absolute;width:10px;height:10px;border-radius:50%;' +
        'z-index:2147483647;pointer-events:auto;box-shadow:0 0 0 2px #fff;';
      document.body.appendChild(dot);
      dots.set(input, dot);
    }
    dot.style.background = DOT_COLORS[state];
    dot.title = 'KGP ERP Autofill: ' + title;
    positionDot(input, dot);
  }

  function positionDot(input, dot) {
    const r = input.getBoundingClientRect();
    dot.style.left = `${r.right + window.scrollX + 6}px`;
    dot.style.top = `${r.top + window.scrollY + r.height / 2 - 5}px`;
  }

  function refreshDots() {
    for (const [input, dot] of dots) {
      if (!input.isConnected || !isVisible(input)) {
        dot.remove();
        dots.delete(input);
      } else {
        positionDot(input, dot);
      }
    }
  }

  // -------------------------------------------------------------- detection

  /** Find visible text that looks like a question, e.g. "What is your pet's name?" */
  function findQuestionElements() {
    const found = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/;
    const endsWithQ = /\?\s*:?\s*$/;

    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.data.indexOf('?') === -1 || !endsWithQ.test(n.data)) continue;
      let el = n.parentElement;
      if (!el || skip.test(el.tagName) || el.hasAttribute(DOT_ATTR)) continue;

      const wordCount = (e) => e.textContent.trim().split(/\s+/).length;
      // Question split across inline tags (<b>name?</b>): widen to the enclosing
      // block, but never climb out of block elements like <td>/<tr>.
      for (let i = 0; i < 2 && INLINE_TAGS.test(el.tagName) && wordCount(el) < 4 && el.parentElement; i++) {
        const parent = el.parentElement;
        const t = parent.textContent.replace(/\s+/g, ' ').trim();
        if (t.length <= 200 && endsWithQ.test(t)) el = parent; else break;
      }
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 200 || wordCount(el) < 3 || !isVisible(el)) continue;
      found.add(el);
    }
    return [...found];
  }

  /** First empty, usable input that follows `qEl` in the document, nearby. */
  function findAnswerInput(qEl, claimed) {
    let scope = qEl;
    for (let depth = 0; depth < 4 && scope; depth++, scope = scope.parentElement) {
      const candidates = [...scope.querySelectorAll('input')].filter(
        (el) =>
          (el.type === 'password' || TEXTLIKE.has(el.type)) &&
          !claimed.has(el) &&
          !isOtp(el) &&
          isUsable(el) &&
          (qEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      if (candidates.length) return candidates[0];
    }
    return null;
  }

  function findQuestionTargets() {
    const claimed = new Set();
    const targets = [];
    for (const qEl of findQuestionElements()) {
      const input = findAnswerInput(qEl, claimed);
      if (!input) continue;
      claimed.add(input);
      targets.push({ input, question: qEl.textContent.replace(/\s+/g, ' ').trim() });
    }
    return targets;
  }

  /** The login form: one password input, plus the nearest text input before it. */
  function findLoginFields(claimed) {
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(
      (el) => isUsable(el) && !claimed.has(el) && !isOtp(el)
    );
    // Zero: nothing to do. More than one: probably a change-password form — skip.
    if (passwords.length !== 1) return null;
    const pass = passwords[0];

    const scope = pass.form || document;
    const notUserField = /answer|otp|captcha|question|search/i;
    const before = [...scope.querySelectorAll('input')].filter(
      (el) =>
        el !== pass &&
        TEXTLIKE.has(el.type) &&
        !claimed.has(el) &&
        !isOtp(el) &&
        !notUserField.test(`${el.name} ${el.id} ${el.placeholder}`) &&
        isUsable(el) &&
        (el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
    return { pass, user: before.length ? before[before.length - 1] : null };
  }

  function findOtpField() {
    const all = [...document.querySelectorAll('input')].filter(
      (el) =>
        (TEXTLIKE.has(el.type) || el.type === 'password') &&
        isOtp(el) &&
        isUsable(el)
    );
    return all[0] || null;
  }

  // ---------------------------------------------------------------- filling

  async function getCredentials() {
    const record = await K.loadRecord();
    if (!record) return { status: 'none' };
    if (!record.encrypted) return { status: 'ok', creds: record.data };
    const unlocked = await K.loadUnlocked();
    return unlocked ? { status: 'ok', creds: unlocked } : { status: 'locked' };
  }

  async function runOnce(force) {
    const summary = {
      found: false, filled: 0, present: 0, unmatched: 0, locked: false, notConfigured: false
    };

    const questionTargets = findQuestionTargets();
    const claimed = new Set(questionTargets.map((t) => t.input));
    const login = findLoginFields(claimed);
    const otp = findOtpField();

    summary.found = questionTargets.length > 0 || !!login || !!otp;

    const wants = (el) => el && isEmpty(el) && (force || !autoFilled.has(el));
    const needsFill =
      questionTargets.some((t) => wants(t.input)) ||
      (login && (wants(login.pass) || wants(login.user)));

    if (needsFill) {
      const { status, creds } = await getCredentials();

      if (status !== 'ok') {
        summary.locked = status === 'locked';
        summary.notConfigured = status === 'none';
        const first =
          (login && (wants(login.user) ? login.user : login.pass)) ||
          (questionTargets[0] && questionTargets[0].input);
        if (first && status === 'locked') {
          setDot(first, 'locked', 'locked — click the extension icon and enter your PIN');
        }
      } else {
        // Login fields
        if (login) {
          if (wants(login.user) && creds.rollNo) {
            setValue(login.user, creds.rollNo);
            autoFilled.add(login.user);
            summary.filled++;
          }
          if (wants(login.pass) && creds.password) {
            setValue(login.pass, creds.password);
            autoFilled.add(login.pass);
            summary.filled++;
          }
        }
        // Security question(s)
        for (const { input, question } of questionTargets) {
          if (!wants(input)) continue;
          const match = K.bestMatch(question, creds.qa);
          if (match) {
            setValue(input, match.pair.a);
            autoFilled.add(input);
            summary.filled++;
            setDot(input, 'filled', 'filled from your saved answer');
          } else {
            summary.unmatched++;
            setDot(input, 'nomatch', 'no confident match for this question — please answer manually');
          }
        }
      }
    }

    // Fields we filled earlier (e.g. automatically on load) and that still hold a value.
    const targets = [login && login.user, login && login.pass, ...questionTargets.map((t) => t.input)];
    summary.present = targets.filter((el) => el && autoFilled.has(el) && !isEmpty(el)).length;

    // OTP: never fill. Just make it ready for typing.
    if (otp && (force || !otpFocused.has(otp))) {
      otpFocused.add(otp);
      otp.focus();
    }

    refreshDots();
    return summary;
  }

  // Serialise runs so overlapping triggers can't interleave.
  let queue = Promise.resolve();
  function run(force) {
    const p = queue.then(() => runOnce(force)).catch((err) => {
      console.debug('KGP ERP Autofill:', err);
      return { found: false, filled: 0, unmatched: 0, error: String(err) };
    });
    queue = p;
    return p;
  }

  // ---------------------------------------------------------------- triggers

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => run(false), DEBOUNCE_MS);
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore changes that are only our own indicator dots.
    const relevant = mutations.some((m) => {
      if (m.target.nodeType === 1 && m.target.hasAttribute(DOT_ATTR)) return false;
      const nodes = [...m.addedNodes, ...m.removedNodes];
      return !(nodes.length && nodes.every((n) => n.nodeType === 1 && n.hasAttribute(DOT_ATTR)));
    });
    if (relevant) schedule();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'type']
  });

  window.addEventListener('resize', refreshDots);
  window.addEventListener('scroll', refreshDots, { passive: true });

  // Unlocking in the popup (or saving settings) should trigger a fill.
  try {
    chrome.storage.onChanged.addListener(() => schedule());
  } catch (e) { /* ignore */ }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && msg && msg.type === 'kgp-run-autofill') {
      run(true).then(sendResponse);
      return true; // async response
    }
  });

  run(false);
})();
