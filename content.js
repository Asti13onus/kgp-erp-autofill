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
  const unlockTries = new WeakMap(); // readonly input -> automatic unlock attempts

  const INLINE_TAGS = /^(B|I|U|EM|STRONG|SPAN|FONT|A|SMALL|SUB|SUP|MARK)$/;
  const TEXTLIKE = new Set(['text', 'number', 'tel', 'email', 'search']);
  // Labels that are just a heading, not an actual question.
  const GENERIC_LABEL = /^(security question|question|answer|answer to security question|your answer)$/;

  // ---------------------------------------------------------------- helpers

  function isVisible(el) {
    if (!el.isConnected || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  const hay = (el) => `${el.name} ${el.id} ${el.placeholder}`;
  const isOtp = (el) => /otp/i.test(hay(el)) || el.autocomplete === 'one-time-code';
  const isAnswerLike = (el) => !isOtp(el) && /answer/i.test(hay(el));
  const isInputType = (el) => el.type === 'password' || TEXTLIKE.has(el.type);
  const isShown = (el) => !el.disabled && isVisible(el);
  const isEmpty = (el) => el.value === '';
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** Set a value the way a user would, so frameworks notice it. */
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * Some ERP fields are readonly until the user clicks into them (an
   * anti-autofill trick). Focusing the field, as a user would, lets the page's
   * own script unlock it. If it stays readonly the page is gating it on purpose
   * and we leave it alone. Focus goes back to wherever it was.
   */
  function ensureWritable(el, force) {
    if (!el.readOnly) return true;
    // Cap automatic attempts so a field the page keeps locked can't cause a loop.
    const tries = unlockTries.get(el) || 0;
    if (!force && tries >= 2) return false;
    unlockTries.set(el, tries + 1);
    const prev = document.activeElement;
    el.focus();
    const ok = !el.readOnly;
    if (prev && prev !== el && prev !== document.body) prev.focus(); else el.blur();
    return ok;
  }

  /**
   * Signal "the user finished typing here" the way a real keystroke + tab-out
   * would (the ERP loads your security question when this happens). Real
   * focus/blur events don't fire while the page window is unfocused (e.g. right
   * after clicking the popup), so when that's the case dispatch them directly.
   */
  function commitBlur(el) {
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    if (document.hasFocus()) {
      const prev = document.activeElement;
      el.focus();
      el.blur();
      if (prev && prev !== el && prev !== document.body) prev.focus();
    } else {
      el.dispatchEvent(new FocusEvent('blur'));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
  }

  // ------------------------------------------------------------- indicators

  const DOT_COLORS = { filled: '#2e9e4f', nomatch: '#e0a100', locked: '#8a8f98', blocked: '#8a8f98' };

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
    dot.dataset.state = state;
    dot.style.background = DOT_COLORS[state];
    dot.title = 'KGP ERP Autofill: ' + title;
    positionDot(input, dot);
  }

  function positionDot(input, dot) {
    const r = input.getBoundingClientRect();
    // Just left of the field, so it never covers an eye/show-password button.
    dot.style.left = `${r.left + window.scrollX - 16}px`;
    dot.style.top = `${r.top + window.scrollY + r.height / 2 - 5}px`;
  }

  function refreshDots() {
    for (const [input, dot] of dots) {
      if (!input.isConnected || !isVisible(input) || (dot.dataset.state === 'locked' && input.value !== '')) {
        dot.remove();
        dots.delete(input);
      } else {
        positionDot(input, dot);
      }
    }
  }

  // -------------------------------------------------------------- detection

  /**
   * The label text sitting above/before an input, e.g. "House at which place".
   * Looks at <label for=…>, then at the sibling just before the input (or its
   * wrapper). Stops at the first sibling that holds another input, so it can
   * never pick up the previous field's label.
   */
  function labelTextFor(input) {
    if (input.labels && input.labels.length) {
      const t = clean(input.labels[0].textContent);
      if (t) return t;
    }
    let node = input;
    for (let depth = 0; depth < 4 && node && node.tagName !== 'FORM'; depth++) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.querySelector('input') || sib.tagName === 'INPUT') return '';
        const t = clean(sib.textContent);
        if (t && t.length <= 200 && isVisible(sib)) return t;
      }
      node = node.parentElement;
    }
    return '';
  }

  /** Visible text ending in "?" (e.g. "What is your pet's name?"), for pages that show one. */
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
        const t = clean(parent.textContent);
        if (t.length <= 200 && endsWithQ.test(t)) el = parent; else break;
      }
      const text = clean(el.textContent);
      if (text.length > 200 || wordCount(el) < 3 || !isVisible(el)) continue;
      found.add(el);
    }
    return [...found];
  }

  /** First empty input that follows `qEl` in the document, nearby. */
  function findAnswerInput(qEl, claimed) {
    let scope = qEl;
    for (let depth = 0; depth < 4 && scope; depth++, scope = scope.parentElement) {
      const candidates = [...scope.querySelectorAll('input')].filter(
        (el) =>
          isInputType(el) &&
          !claimed.has(el) &&
          !isOtp(el) &&
          isShown(el) &&
          isEmpty(el) &&
          (qEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      if (candidates.length) return candidates[0];
    }
    return null;
  }

  function findQuestionTargets() {
    const claimed = new Set();
    const targets = [];

    // 1) Free-standing text ending in "?" followed by an empty input (most precise).
    for (const qEl of findQuestionElements()) {
      const input = findAnswerInput(qEl, claimed);
      if (!input) continue;
      claimed.add(input);
      targets.push({ input, question: clean(qEl.textContent) });
    }

    // 2) Inputs that say they are the security answer (name/id/placeholder
    //    contains "answer", not already claimed); the question is the label above them. This is how
    //    the real ERP login page is laid out.
    for (const input of document.querySelectorAll('input')) {
      if (claimed.has(input) || !isInputType(input) || !isAnswerLike(input) || !isShown(input)) continue;
      const question = labelTextFor(input);
      if (!question || GENERIC_LABEL.test(K.normalizeQuestion(question))) continue;
      claimed.add(input);
      targets.push({ input, question });
    }

    return targets;
  }

  /** The login form: a password field plus the user-id field. */
  function findLoginFields(claimed) {
    const cand = [...document.querySelectorAll('input')].filter(
      (el) => isInputType(el) && !claimed.has(el) && !isOtp(el) && !isAnswerLike(el) && isShown(el)
    );

    // Password field: named like "password"; otherwise the only type=password left.
    const passLike = cand.filter((el) => /pass/i.test(`${el.name} ${el.id}`));
    let pass = null;
    if (passLike.length === 1) {
      pass = passLike[0];
    } else if (passLike.length === 0) {
      const pws = cand.filter((el) => el.type === 'password');
      if (pws.length === 1) pass = pws[0];
    }
    // Several password-ish fields (e.g. new + confirm): probably a change-password form.
    if (!pass) return null;

    const sameForm = cand.filter((el) => el !== pass && (!pass.form || el.form === pass.form));
    // User field: named like user/roll/login, else the nearest text input before the password.
    let user = sameForm.find((el) => /user|roll|login|emp/i.test(`${el.name} ${el.id}`)) || null;
    if (!user) {
      const before = sameForm.filter(
        (el) => TEXTLIKE.has(el.type) && (el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      user = before.length ? before[before.length - 1] : null;
    }
    return { pass, user };
  }

  function findOtpField() {
    return (
      [...document.querySelectorAll('input')].find(
        (el) => isInputType(el) && isOtp(el) && isShown(el)
      ) || null
    );
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
      found: false, filled: 0, present: 0, unmatched: 0, blocked: 0, locked: false, notConfigured: false
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

    // Fill one field; returns false if the page keeps it locked.
    const fill = (el, value, commit) => {
      if (!ensureWritable(el, force)) { summary.blocked++; return false; }
      setValue(el, value);
      if (commit) commitBlur(el);
      autoFilled.add(el);
      summary.filled++;
      return true;
    };

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
        if (login) {
          // Blur after the roll number: the ERP loads your security question then.
          if (wants(login.user) && creds.rollNo) fill(login.user, creds.rollNo, true);
          if (wants(login.pass) && creds.password) fill(login.pass, creds.password, false);
        }
        for (const { input, question } of questionTargets) {
          if (!wants(input)) continue;
          const match = K.bestMatch(question, creds.qa);
          if (match) {
            if (fill(input, match.pair.a, false)) setDot(input, 'filled', 'filled from your saved answer');
          } else {
            summary.unmatched++;
            setDot(input, 'nomatch', 'no confident match for this question — please answer manually');
          }
        }
      }
    }

    // Fields we filled earlier (e.g. automatically on load) that still hold a value.
    const targets = [login && login.user, login && login.pass, ...questionTargets.map((t) => t.input)];
    summary.present = targets.filter((el) => el && autoFilled.has(el) && !isEmpty(el)).length;

    // OTP: never fill. Just make it ready for typing. Only focus it once it is
    // actually editable (or when the user asks via "Run autofill now"), so we
    // never pull focus away while the user is typing elsewhere.
    if (otp && (force || (!otp.readOnly && !otpFocused.has(otp)))) {
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
    characterData: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'type', 'readonly', 'disabled']
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
