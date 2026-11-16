# KGP ERP Autofill

A small Chrome extension (Manifest V3) that fills **your own** saved login details
on the IIT Kharagpur ERP login page, so you only have to review the form, type the
OTP and click submit.

> **Unofficial.** This project is not affiliated with, endorsed by, or sponsored by
> IIT Kharagpur or the ERP team. Use it at your own risk and follow the institute's
> IT policies.

## What it does

On `https://erp.iitkgp.ac.in/*` it watches the page (with a `MutationObserver`, so
fields that appear later are picked up too) and:

| Step | Behaviour |
| --- | --- |
| **Roll number + password** | Finds the password input (by name/id, e.g. `password`) and the user-id input (`user_id`, or the nearest text input before the password), and fills both if empty. Works when the page uses `type="password"` for every field. Skips forms with several password-like fields (e.g. change-password). |
| **Security question** | Finds the question either as visible text ending in `?` next to an empty input, or as the label above an input whose name/id/placeholder says "answer" (the real ERP login layout, where the question has no `?`). It normalizes the text (lowercase, punctuation stripped) and fuzzy-matches it by word overlap against your saved questions. It fills only if the match is confident *and* clearly better than any other saved question. Otherwise it fills nothing and shows a small amber dot beside the field. |
| **OTP** | Never filled. Once the OTP field is editable it is just focused so you can type it. |
| **Events** | After filling, `input` and `change` events are dispatched so page JavaScript notices the new values. |
| **Submit** | Never auto-submitted. You review and click submit yourself. |

Indicator dots: green = filled from a saved answer, amber = no confident match
(answer manually), grey = saved data is locked (click the extension icon and enter
your PIN).

It makes **no network requests** and has no dependencies or build step. The only
host permission is `*://erp.iitkgp.ac.in/*`, plus `storage`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Click the extension's toolbar icon → **Open settings**, and enter your roll number,
   password and security question/answer pairs. Optionally set a 4-digit PIN.
5. Open the ERP login page. Fields are filled automatically, or press
   **Run autofill now** in the popup.

After editing any file, click the reload icon on the extension's card in
`chrome://extensions` and reload the ERP tab.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, content script, popup, options page |
| `content.js` | Detection and filling logic that runs on the ERP |
| `shared.js` | Question matching, AES-GCM/PBKDF2 helpers, storage helpers |
| `options.html` / `options.js` | Settings: roll no, password, Q/A pairs, optional PIN |
| `popup.html` / `popup.js` | Status, unlock/lock, "Run autofill now", settings link |
| `styles.css` | Shared styling |

## Security: plain text vs PIN-encrypted storage

Everything is saved in `chrome.storage.local` (device-local; never
`chrome.storage.sync`, so nothing is uploaded to your Google account).

**No PIN (plain text).** Your password and answers sit unencrypted in your Chrome
profile directory. Anyone who can read your profile files, other software running
as you, or someone using your unlocked computer could read them. The settings page
shows a warning while no PIN is set. This is the most convenient option and the
least safe.

**With a 4-digit PIN (encrypted).** Credentials are encrypted with AES-256-GCM using
a key derived from your PIN with PBKDF2 (SHA-256, 600,000 iterations, random salt).
You unlock once per browser session from the popup (click the icon and type the 4 digits: it unlocks, fills, and closes by itself); the decrypted copy is then held
in `chrome.storage.session` (memory only, cleared when the browser closes or when
you press **Lock now**) so autofill works across the ERP's page loads. The PIN is
never stored.

Be realistic about what this buys you:

- A 4-digit PIN has only 10,000 possibilities. The iteration count slows an
  attacker down, but someone who copies the encrypted blob can still brute-force it
  offline in a feasible amount of time. It protects against casual snooping and
  accidental exposure, **not** against a determined attacker with your files.
- While unlocked, the plaintext lives in extension memory for the rest of the
  browser session.
- Any malware or malicious extension with access to your browser or profile can
  defeat either mode.
- The PIN is typed into the extension popup/options page (not into the ERP page),
  so the website's scripts cannot see it.

If your threat model is serious, prefer a real password manager and keep this
extension's data minimal (for example, skip storing the password and only keep the
security answers).

## Privacy

- No analytics, no telemetry, no remote code, no network calls from the extension.
- No credentials are hard-coded anywhere in this repository. All values come from
  what you type into the settings page.
- Use **Delete all saved data** in settings to wipe everything.

## Limitations

- Some ERP fields are `readonly` until clicked. The extension focuses them (as you would) so the page's own script unlocks them; if a field stays locked, it is left alone.
- The ERP's markup isn't something this project controls; if its layout changes,
  detection may need tweaks.
- Only the top-level page is scanned (not iframes).
- Matching is word-overlap based: very short or very generic questions may be
  treated as "no confident match" on purpose, and you answer those manually.
