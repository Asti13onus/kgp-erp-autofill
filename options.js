(() => {
  'use strict';
  const K = globalThis.KGP;
  const $ = (id) => document.getElementById(id);

  const els = {
    unlockBox: $('unlockBox'), unlockPin: $('unlockPin'), unlockBtn: $('unlockBtn'),
    unlockMsg: $('unlockMsg'), editor: $('editor'), roll: $('roll'), pw: $('pw'),
    qaList: $('qaList'), addRow: $('addRow'), showSecrets: $('showSecrets'),
    pin: $('pin'), warn: $('warn'), info: $('info'), save: $('save'),
    clear: $('clear'), msg: $('msg')
  };

  let hadPin = false; // saved data was encrypted when this page loaded

  function setMsg(el, text, kind) {
    el.textContent = text;
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  // --------------------------------------------------------------- QA rows

  function secretType() {
    return els.showSecrets.checked ? 'text' : 'password';
  }

  function addRow(q = '', a = '') {
    const row = document.createElement('div');
    row.className = 'qa';

    const qi = document.createElement('input');
    qi.type = 'text';
    qi.placeholder = 'Question, e.g. What is your pet’s name?';
    qi.value = q;
    qi.autocomplete = 'off';

    const ai = document.createElement('input');
    ai.type = secretType();
    ai.dataset.secret = '1';
    ai.placeholder = 'Answer';
    ai.value = a;
    ai.autocomplete = 'new-password';

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon';
    rm.title = 'Remove';
    rm.textContent = '✕';
    rm.addEventListener('click', () => row.remove());

    row.append(qi, ai, rm);
    els.qaList.appendChild(row);
  }

  function readForm() {
    const qa = [...els.qaList.querySelectorAll('.qa')]
      .map((row) => {
        const [q, a] = row.querySelectorAll('input');
        return { q: q.value.trim(), a: a.value };
      })
      .filter((p) => p.q && p.a);
    return { rollNo: els.roll.value.trim(), password: els.pw.value, qa };
  }

  function fillForm(data) {
    els.roll.value = (data && data.rollNo) || '';
    els.pw.value = (data && data.password) || '';
    els.qaList.textContent = '';
    const qa = (data && data.qa) || [];
    if (qa.length) qa.forEach((p) => addRow(p.q, p.a)); else addRow();
  }

  function updatePinNotice() {
    const hasPin = els.pin.value.length > 0;
    els.warn.hidden = hasPin;
    els.info.hidden = !hasPin;
  }

  // ------------------------------------------------------------------ init

  async function init() {
    const record = await K.loadRecord();
    updatePinNotice();

    if (record && record.encrypted) {
      hadPin = true;
      els.unlockBox.hidden = false;
      els.unlockPin.focus();
    } else {
      fillForm(record && record.data);
      els.editor.hidden = false;
    }
  }

  els.unlockBtn.addEventListener('click', async () => {
    const pin = els.unlockPin.value;
    if (!/^\d{4}$/.test(pin)) return setMsg(els.unlockMsg, 'Enter your 4-digit PIN.', 'err');
    els.unlockBtn.disabled = true;
    setMsg(els.unlockMsg, 'Unlocking…');
    try {
      const record = await K.loadRecord();
      const data = await K.decryptData(record, pin);
      fillForm(data);
      els.pin.value = pin; // keep encryption on unless the user clears this
      updatePinNotice();
      els.unlockBox.hidden = true;
      els.editor.hidden = false;
    } catch (e) {
      setMsg(els.unlockMsg, 'Wrong PIN.', 'err');
    } finally {
      els.unlockBtn.disabled = false;
    }
  });
  els.unlockPin.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.unlockBtn.click();
  });

  els.addRow.addEventListener('click', () => addRow());
  els.pin.addEventListener('input', updatePinNotice);

  els.showSecrets.addEventListener('change', () => {
    const type = secretType();
    els.pw.type = type;
    els.qaList.querySelectorAll('input[data-secret]').forEach((i) => { i.type = type; });
  });

  els.editor.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = readForm();
    const pin = els.pin.value.trim();

    if (!data.rollNo || !data.password) {
      return setMsg(els.msg, 'Roll number and password are required.', 'err');
    }
    if (pin && !/^\d{4}$/.test(pin)) {
      return setMsg(els.msg, 'PIN must be exactly 4 digits (or leave it empty).', 'err');
    }
    if (!pin && hadPin &&
        !confirm('PIN is empty: this will REMOVE encryption and store your details in plain text. Continue?')) {
      return;
    }

    els.save.disabled = true;
    setMsg(els.msg, pin ? 'Encrypting and saving…' : 'Saving…');
    try {
      const record = pin
        ? await K.encryptData(data, pin)
        : { v: 1, encrypted: false, data };
      await K.saveRecord(record);
      await K.lock(); // drop any stale unlocked copy; unlock again from the popup
      hadPin = !!pin;
      setMsg(els.msg,
        pin ? 'Saved (encrypted). Unlock from the extension popup to autofill.'
            : 'Saved (UNENCRYPTED).',
        'ok');
    } catch (err) {
      setMsg(els.msg, 'Could not save: ' + err.message, 'err');
    } finally {
      els.save.disabled = false;
    }
  });

  els.clear.addEventListener('click', async () => {
    if (!confirm('Delete your saved roll number, password and security answers from this browser?')) return;
    await K.clearAll();
    hadPin = false;
    els.pin.value = '';
    fillForm(null);
    updatePinNotice();
    setMsg(els.msg, 'All saved data deleted.', 'ok');
  });

  init();
})();
