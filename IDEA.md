# Pass123 — Chrome Extension for Password Storage & Generation

## Concept

A privacy-first Chrome extension that **generates strong passwords** and **stores them locally**, encrypted behind a single master password. No accounts, no servers — the user's vault never leaves their machine unless they choose to export it.

## Goals

- Generate strong, configurable passwords on demand.
- Store credentials (site, username, password, notes) encrypted at rest.
- Autofill saved credentials into login forms.
- Unlock the vault with one master password; auto-lock after inactivity.
- Zero third-party servers in v1 (everything client-side).

## Non-goals (v1)

- Cross-device cloud sync.
- Team/shared vaults.
- Browser-other-than-Chrome support.
- Password breach monitoring (consider for later).

## Core Features

### 1. Password Generator
- Adjustable length (e.g. 8–64).
- Toggle character sets: uppercase, lowercase, numbers, symbols.
- Options: exclude ambiguous chars (`l`, `1`, `O`, `0`), require one of each selected set.
- Optional passphrase mode (word list + separators).
- Strength meter (entropy estimate, e.g. via `zxcvbn`).
- One-click copy; copied value auto-clears from clipboard after ~30s.

### 2. Vault (Storage)
- Entries: `title`, `url`, `username`, `password`, `notes`, `createdAt`, `updatedAt`.
- Search / filter by title or URL.
- Add, edit, delete, and reveal entries.
- All entry data encrypted before being written to storage.

### 3. Autofill & Capture
- Content script detects login forms on a page.
- Offer to fill matching saved credentials (matched by domain).
- Offer to save a new credential after a successful submit.

### 4. Security / Master Password
- Master password is **never stored**; derive an encryption key from it.
- Key derivation: PBKDF2 or Argon2 (high iteration count) → AES-GCM key.
- Vault auto-locks after configurable idle timeout and on browser close.
- Wrong master password simply fails to decrypt (no separate "password check").

## Security Model

| Concern | Approach |
|---|---|
| Key derivation | PBKDF2-SHA256 (≥310k iters) or Argon2id, with a random per-vault salt |
| Encryption | AES-256-GCM via Web Crypto API (`crypto.subtle`) |
| Master password | Held in memory only while unlocked; cleared on lock |
| Data at rest | Only ciphertext + salt + IV stored; never plaintext |
| Clipboard | Auto-clear generated/copied secrets after a timeout |
| XSS surface | Strict CSP; no inline scripts; sanitize all rendered vault data |

> Threat note: a local password manager protects against *casual access to stored data*, not against a fully compromised OS or keylogger. Document this honestly.

## Architecture (Manifest V3)

```
manifest.json          # MV3 manifest, permissions, action, background SW
background/             # Service worker: lock state, key lifecycle, messaging
popup/                 # Toolbar UI: unlock, generator, vault list, settings
content/               # Content scripts: form detection, autofill, capture
lib/
  crypto.ts            # KDF + AES-GCM wrappers (Web Crypto)
  vault.ts             # CRUD over encrypted store
  generator.ts         # Password / passphrase generation
  storage.ts           # chrome.storage.local read/write of ciphertext
```

- **Manifest V3** — background logic runs in a service worker (ephemeral; persist lock state carefully).
- **Storage**: `chrome.storage.local` holds only encrypted blobs. The derived key lives in the service worker's memory while unlocked, not in storage.
- **Messaging**: popup/content ↔ background via `chrome.runtime` messaging; crypto stays in the background context.

### Suggested stack
- TypeScript + a bundler (Vite or esbuild) with a CRX/MV3 plugin.
- Web Crypto API (no heavy crypto deps).
- Optional: React or vanilla TS for the popup; `zxcvbn` for strength scoring.

## Permissions (minimize)

- `storage` — persist the encrypted vault.
- `activeTab` / `scripting` — autofill on the current page.
- `clipboardWrite` — copy generated passwords.
- Host permissions: prefer `activeTab` over broad `<all_urls>` where possible.

## UX Flow

1. **First run** → set master password → vault initialized (salt generated).
2. **Unlock** → enter master password → key derived → vault decrypted into memory.
3. **Generate** → tweak options → copy or save directly to vault.
4. **Autofill** → visit a site → matching entries offered in the form.
5. **Lock** → manual button or idle timeout → key cleared from memory.

## Roadmap

- **v0.1 (MVP)** ✅: generator + manual vault (add/view/copy/edit/delete/search), master-password encryption, manual + idle auto-lock.
- **v0.2** ✅: autofill + capture-on-submit on login forms (save/update banner), idle auto-lock, and a settings panel (configurable lock timeout, capture toggle, clipboard-clear delay, delete-vault).
- **v0.3**: encrypted import/export (e.g. encrypted JSON), passphrase mode in the generator.
- **Later**: optional E2E sync, breach checks (HIBP k-anonymity), biometric unlock via WebAuthn.

## Open Questions

- KDF choice: Argon2id (stronger, needs WASM) vs PBKDF2 (built into Web Crypto)?
- Export format and how to make backups safe yet recoverable?
- How to handle the MV3 service-worker termination without forcing frequent re-unlock?
