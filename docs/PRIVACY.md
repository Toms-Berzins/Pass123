# Pass123 Privacy Policy

_Last updated: 2026-06-20_

Pass123 is built on one promise: **nothing to breach.** This policy is short because there is almost nothing to disclose — and we'd rather state that plainly than bury it in legalese.

## The one-sentence version

**Pass123 collects nothing, sends nothing, and stores nothing off your device.** There is no account, no server, no analytics, and no telemetry. Your vault never leaves your machine.

## What we collect

**Nothing.** We do not collect, transmit, sell, rent, or share any personal information, usage data, or analytics. There is no sign-up, no email, no device identifier, and no tracking of any kind.

## What is stored, and where

Everything Pass123 saves lives only in your browser's local extension storage (`chrome.storage.local`) on your own device:

- **Your vault** — passwords, usernames, URLs, notes, and TOTP secrets — is stored as **AES-256-GCM ciphertext**. It is encrypted with a key derived from your master password (and, if you set them up, your recovery phrase or device biometrics). Pass123 cannot read your vault without that secret, and neither can anyone else.
- **Your master password is never stored** — not on disk, not in the cloud, not anywhere. The decryption key exists only in the extension's background memory while the vault is unlocked, and is dropped when you lock it or after the idle auto-lock timer fires.
- **Non-secret preferences** (auto-lock timeout, capture toggle, clipboard-clear delay) are stored unencrypted in the same local storage. They contain no personal data.

None of this is ever transmitted anywhere. There is no Pass123 server to transmit it to.

## What leaves your device

**Nothing leaves your device.** Pass123 has no backend, makes no network requests of its own, and contacts no third-party service. The optional, opt-in **Pass123 Sync** product (not yet released) will, if you ever choose to enable it, transmit only **end-to-end-encrypted ciphertext** to a relay that cannot read it — this policy will be updated before any such feature ships, and it will always be opt-in.

## Permissions, and why each is needed

Pass123 requests the **minimum** Chrome permissions required to function. None of them are used to collect data:

| Permission | Why it's needed |
|---|---|
| `storage` | To save your encrypted vault and preferences locally on your device. |
| `activeTab` + `scripting` | To detect login fields and autofill credentials **only on the tab you're actively using, only when you ask**. Credentials are passed from the extension into the page's form fields; they are never sent to us. |
| `alarms` | To run the idle auto-lock timer that clears your decryption key from memory after a period of inactivity. |
| `clipboardWrite` | To copy a password or TOTP code to your clipboard when you click "copy." Pass123 can optionally clear it again after a delay; it never reads your clipboard. |

A full reviewer-facing breakdown lives in [`PERMISSIONS.md`](./PERMISSIONS.md).

## Third parties

There are none. Pass123 includes no third-party SDKs, analytics, ad networks, or crash reporters. The cryptography uses only the browser's built-in [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API).

## What this protects — stated honestly

Pass123 encrypts your stored credentials so they are protected against casual access to your device's data. It is **not** a defense against a fully compromised operating system, malware, or a keylogger running on your machine — no password manager is. We'd rather tell you that up front than pretend otherwise.

## Children

Pass123 is a general-purpose utility and is not directed at children. Because it collects no data, it does not knowingly collect information from anyone, including children under 13.

## Changes to this policy

If we ever change what Pass123 does with data — for example, if you opt into the future Sync product — we will update this page and the version date above **before** the change ships. Because the extension is open source, every such change is publicly visible in the commit history.

## Contact

Questions about privacy? Open an issue on the GitHub repository, or email **berzinstoms@gmail.com**.

---

_Pass123 is free and open source. You don't have to take our word for any of the above — you can read the code._
