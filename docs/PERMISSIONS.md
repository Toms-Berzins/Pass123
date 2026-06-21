# Pass123 — Permissions Justification

_Reviewer-facing reference for the Chrome Web Store "Permission justification" disclosure form. Mirror these into the listing's privacy practices tab verbatim — they are written to be pasted in._

## Single purpose

Pass123 is a **local, offline password manager and generator**. It creates strong passwords and stores credentials in an AES-256-GCM encrypted vault that lives only in the user's browser, behind a master password. It can autofill saved logins into the page the user is currently on. There is no account, no server, and no network activity originating from the extension.

## Permission-by-permission justification

### `storage`
Used to persist the user's encrypted vault and non-secret preferences in `chrome.storage.local`. The vault is stored as ciphertext only; the master password and decryption key are never written to storage. No data is synced or transmitted — this is purely on-device persistence.

### `activeTab`
Used to fill saved credentials into the login form of the tab the user is **actively interacting with**, only in response to an explicit user action (clicking "fill" in the popup or accepting an autofill prompt). It grants access to the current tab on demand rather than standing access to all sites.

### `scripting`
Used to inject the autofill logic that locates username/password fields and to detect login submissions so the extension can offer to save a new credential. Injection is scoped to login-form interactions; no remote or arbitrary code is executed — all scripts are bundled with the extension (`script-src 'self'`).

### `alarms`
Used to schedule the idle **auto-lock** timer. When the timer fires, the extension drops the in-memory decryption key and re-locks the vault, so an unattended browser does not leave the vault unlocked. This is a security feature, not a data-collection mechanism.

### `clipboardWrite`
Used to copy a password or one-time (TOTP) code to the clipboard when the user clicks "copy," and to optionally clear it again after a configurable delay. The extension only writes to the clipboard on user action; it never reads clipboard contents.

## Host permissions / content scripts

The content script matches `http://*/*` and `https://*/*` (including sub-frames, `all_frames: true`) so that login forms — including those inside cross-origin iframes such as embedded SSO widgets — can be detected and filled. The script is near-inert until a login field is present or the user triggers a fill, and credential/banner traffic is gated to the top frame. **No page content is ever read for analytics or transmitted off the device.**

## Remote code

**None.** All JavaScript is bundled into the extension package. The content security policy is `script-src 'self'; object-src 'self'` — no inline scripts, no remotely hosted code, no `eval`.

## Data usage disclosures (CWS "Privacy practices" tab)

Answer the certification questions as follows:

- **Does this item collect or use personal/sensitive user data?** The extension stores authentication information (passwords) **locally and encrypted on the user's device only**. It does **not** collect or transmit any data to the developer or any third party.
- **Is data sold to third parties?** No.
- **Is data used or transferred for purposes unrelated to the item's single purpose?** No.
- **Is data used or transferred to determine creditworthiness or for lending?** No.

The full user-facing privacy policy is at [`PRIVACY.md`](./PRIVACY.md) and must be linked in the listing.

## Why this set is minimal

Pass123 deliberately omits broad permissions it does not need: no `tabs` (no need to read all tab URLs/titles), no `<all_urls>` host permission beyond the content-script match required for autofill, no `webRequest`, no `cookies`, no `history`, no background network permissions. The permission list (`storage`, `activeTab`, `scripting`, `alarms`, `clipboardWrite`) is the smallest set that supports local storage, on-demand autofill, auto-lock, and copy-to-clipboard.
