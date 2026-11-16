(() => {
  'use strict';
  const K = globalThis.KGP;
  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const statusText = $('statusText');
  const msg = $('msg');

  function setMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function setStatus(kind, text) {
    statusEl.className = 'status ' + kind;
    statusText.textContent = text;
  }

  async function refresh() {
    const record = await K.loadRecord();
    const unlocked = record && record.encrypted ? await K.loadUnlocked() : null;

    $('unlockBox').hidden = !(record && record.encrypted && !unlocked);
    $('lockBtn').hidden = !unlocked;
    const locked = !!(record && record.encrypted && !unlocked);
    $('run').hidden = locked || !record;
    if (locked) $('pin').focus();

    if (!record) setStatus('bad', 'Not configured');
    else if (!record.encrypted) setStatus('warn', 'Configured (plain text, unencrypted)');
    else if (unlocked) setStatus('ok', 'Configured (encrypted) – unlocked');
    else setStatus('warn', 'Configured (encrypted) – locked');
  }

  async function runAutofill() {
    setMsg('');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let onErp = false;
    try { onErp = new URL(tab.url).hostname === 'erp.iitkgp.ac.in'; } catch (e) { /* no url */ }
    if (!tab || !onErp) {
      return setMsg('Open the ERP login page (erp.iitkgp.ac.in) in this tab first.', 'err');
    }
    let res;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'kgp-run-autofill' });
    } catch (e) {
      return setMsg('Page not ready. Reload the ERP tab and try again.', 'err');
    }
    if (!res) return setMsg('No response from the page.', 'err');
    if (res.locked) return setMsg('Locked – enter your PIN above.', 'err');
    if (res.notConfigured) return setMsg('Not configured – open settings and save your details.', 'err');
    if (!res.found) return setMsg('No login, question or OTP fields found on this page.');

    const parts = [];
    if (res.filled) parts.push(`Filled ${res.filled} field${res.filled === 1 ? '' : 's'}.`);
    if (res.present) parts.push(`${res.present} already filled.`);
    if (!parts.length && !res.unmatched) parts.push('Nothing to fill (fields already have values).');
    if (res.unmatched) {
      parts.push(`${res.unmatched} security question${res.unmatched === 1 ? '' : 's'} had no confident match – answer manually.`);
    }
    setMsg(parts.join(' '), res.unmatched ? '' : 'ok');
  }

  $('run').addEventListener('click', runAutofill);

  let unlocking = false;
  async function doUnlock() {
    const pin = $('pin').value;
    if (unlocking || !/^\d{4}$/.test(pin)) return;
    unlocking = true;
    $('unlockBtn').disabled = true;
    setMsg('Unlocking…');
    try {
      const record = await K.loadRecord();
      const data = await K.decryptData(record, pin);
      await K.setUnlocked(data);
      $('pin').value = '';
      await refresh();
      await runAutofill();
      // One-tap flow: close the popup once the fill has been triggered.
      setTimeout(() => window.close(), 900);
    } catch (e) {
      setMsg('Wrong PIN.', 'err');
      $('pin').value = '';
      $('pin').focus();
    } finally {
      unlocking = false;
      $('unlockBtn').disabled = false;
    }
  }

  $('unlockBtn').addEventListener('click', doUnlock);
  // Unlock automatically as soon as the 4th digit is typed.
  $('pin').addEventListener('input', () => {
    $('pin').value = $('pin').value.replace(/\D/g, '').slice(0, 4);
    if ($('pin').value.length === 4) doUnlock();
  });
  $('pin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doUnlock();
  });

  $('lockBtn').addEventListener('click', async () => {
    await K.lock();
    setMsg('Locked.');
    await refresh();
  });

  $('options').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  refresh();
})();
