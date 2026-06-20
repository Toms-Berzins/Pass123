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

> Reprioritized 2026-06-20 from market research (`docs/REASEARCH.md`). **Thesis: win by *subtraction* then *execution*.** Being local-only / no-account / no-subscription structurally eliminates ~44% of the category's complaint surface (pricing, sync corruption, breach) and immunizes us against the cloud-server attack class — that's the hook. But subtraction leaves two things we *must* nail, because architecture won't save us there: **(1) autofill reliability** (the #1 complaint at 29%) and **(2) master-password recoverability** (no account = no backdoor = the single-point-of-failure fear, re-created at the individual level). "Local-only" is now table stakes in our sub-niche — competitors already ship TOTP, WebAuthn unlock, and recovery phrases that we lack.

- **v0.1 (MVP)** ✅: generator + manual vault (add/view/copy/edit/delete/search), master-password encryption, manual + idle auto-lock.
- **v0.2** ✅: autofill + capture-on-submit on login forms (save/update banner), idle auto-lock, and a settings panel (configurable lock timeout, capture toggle, clipboard-clear delay, delete-vault).

- **v0.3 — Survivability (makes "no cloud" safe to rely on)** ✅. The honest answer to "all eggs in one basket." Without this, the no-account model is a liability, not a feature.
  - **① Key-wrapping refactor (do this FIRST — it's the enabler for everything below and in v0.4).** ✅ Done. Today the master password's PBKDF2 output *is* the AES data key (key == data key), so any new unlock method would require re-encrypting the whole vault. Refactor to the standard wrapping model: generate one **random 256-bit AES-GCM vault key** that encrypts all entries; **wrap that vault key separately per unlock method** (master password now derives a *wrapping* key, not the data key). Adding/rotating an unlock method then just re-wraps the same vault key — data is never re-encrypted. This makes recovery phrase (below), biometric/WebAuthn unlock (v0.4), and future passkey unlock all **additive** instead of each being a vault rewrite. Store each wrap as a small blob (`{ version, wrappedVaultKey, salt, iv, createdAt }`). See `docs/COMPETITOR_RECOVERY_TOTP.md` (Nemo teardown) for the reference design. *Migration note: existing v0.2 vaults derive key-from-password directly — ship a one-time unlock-and-rewrap migration that mints a vault key and wraps it under the current master password.* *(Implemented as StoredVaultV2 `keyWraps[]` + v1→v2 migrate-on-unlock in `vault.ts`.)*
  - **② BIP39 recovery phrase** ✅ Done. Generated at vault setup — derives a wrapping key (HKDF) that wraps the same vault key, so it restores access independent of the master password. Onboarding UX: numbered-grid word display, Regenerate, Copy-all with confirmation, and a required "I've saved this" checkbox gating completion. *(12-word English BIP39 in `bip39.ts` + verified official wordlist; HKDF wrap via `deriveKeyFromEntropy`; `setupRecoveryPhrase`/`changeMasterPassword` in `vault.ts`; recover-with-phrase + set-new-master flows in the popup. Settings can regenerate after re-entering the master password.)*
  - **③ Printable emergency kit** ✅ Done. Recovery phrase + restore instructions — Print/Download (self-contained local-Blob HTML) alongside Copy on the recovery screen.
  - Encrypted import/export (encrypted JSON) ✅ Done. — *was the whole of v0.3; now the floor.* *(`backup.ts`: entries AES-256-GCM encrypted under a separate **export password** (PBKDF2), self-describing `pass123-export` file; import merges via `mergeEntries`, deduping on url+username+password and re-keying ids. Export/import screens in Settings → Backup & restore.)*
  - Passphrase mode in the generator ✅ Done. *(Diceware-style over the BIP39 wordlist — 11 bits/word; word-count, separator, capitalize, and add-a-digit controls; live entropy/strength. Password/Passphrase toggle on the Generate tab.)*

- **v0.4 — Table stakes (catch up to the local-extension field)** ✅. Things hobby competitors already ship; their absence makes us look *behind*.
  - **TOTP / 2FA codes** stored in entries (free — unlike Bitwarden, which gates it). ✅ Done. *(`totp.ts`: RFC 6238/4226, Web-Crypto HMAC, SHA-1/256/512, base32, `otpauth://` parse/build — verified against the official RFC 6238 vectors. Secret stored as the optional `VaultEntry.totp` field, so it rides the same AES-GCM envelope and exports with the vault. Entry form takes a base32 secret or a pasted `otpauth://` URI; entry cards show a live code + countdown driven by one shared 1s ticker, copy button, <5s warning.)*
  - **WebAuthn / biometric unlock** (Touch ID / Windows Hello / passkey authenticator) as a master-password alternative — derives a wrapping key (WebAuthn PRF → HKDF) over the **same vault key** from v0.3's wrapping refactor, so it's purely additive; vault key still memory-only. ✅ Done. *(`webauthn.ts` enrolls a platform credential with the PRF extension in the popup; the PRF output → `deriveKeyFromEntropy` (HKDF) wraps the vault key as a `biometric` `KeyWrap` (stores the credential id). `addBiometricWrap`/`unlockWithBiometric`/`removeBiometricWrap` in `vault.ts`; unlock-screen button + Settings enable/disable; master password stays as fallback.* **Browser-only flow — not unit-tested; verify by loading the unpacked extension on a Hello/Touch-ID device. RP id = extension origin host; if Chrome rejects extension-origin WebAuthn this needs revisiting.)**

- **v0.5 — Autofill robustness (the moat).** 🚧 In progress. The #1 complaint in the whole category; where execution depth beats even the incumbents. Treated as a standing workstream with real-site regression coverage, not a one-off.
  - **Registrable-domain (eTLD+1) matching** ✅. New `src/lib/urlmatch.ts` (pure, 30 regression tests): `registrableDomain`/`sameSite`/`rankMatches`/`filterByUsername`, with a curated multi-part public-suffix set (no bundled PSL). `matchEntries` now ranks exact-host > subdomain > sibling-subdomain, so a saved `example.com` autofills on `login.example.com` and capture treats a subdomain login as the same account. **Wrong-account suppression** rides on this: `captureDecision` (via `sameSite`) never resolves a login to an entry on a different registrable domain, and `filterByUsername` narrows to the account in use.
  - **Cross-host redirect capture gap** ✅ (submit on host A, land on host B). The background `pending` map is keyed by registrable domain (covers subdomain redirects); for true cross-domain redirects, `resolvePending` falls back to a capture from the **same tab** within a 90s window, surfaced at most once — so the redirect is caught without spurious offers on later/unrelated navigation. Tab id comes from `sender.tab.id`.
  - **Multi-step / SPA login flows** ✅. `content.ts` field detection now filters hidden/disabled/search/OTP fields and honors `autocomplete`/`aria-label`/`type=email` (preferring `current-password` for autofill). A remembered username (content-world only, never written to the page) pairs a later password-only step; SPA logins are captured by hooking History `pushState`/`replaceState`/`popstate`, snapshotting credentials before the route swaps the form out.
  - **Popup payoff** ✅. The vault list now shows a "For this site" section (ranked current-tab matches) above all passwords.
  - Remaining: resilience to Chrome-behavior changes; broaden the real-site regression table; cross-*document* multi-step (username page → password page on a full navigation) still relies on per-step pages each carrying the username.

- **v0.6 — Launch-readiness (turn the code into a shipped product).** The roadmap so far is all engineering; nothing reaches a user until this lands. No new vault surface — it's the work that lets us *publish*. Grounded in `docs/business/` (90-day plan, Days 0–30).
  - **Crypto & migration hardening.** Heavy test pass on the v1→v2 key-wrapping migration and every `keyWraps[]` path (master / recovery / biometric) — vault-loss is existential risk #1. Add fuzz/property tests around `unlockVault` wrap-trial order and a non-destructive migration guarantee (never write a re-wrap until the new wrap verifies).
  - **Onboarding & recovery-nudge polish.** First-run flow must make BIP39 backup + emergency-kit unmissable (the inverted-recovery risk: no account = no backdoor). Periodic "have you saved your recovery phrase?" nudge.
  - **Store shipping kit.** Privacy policy (state the honest threat model verbatim), Chrome Web Store listing + screenshots, minimal landing page, GitHub Sponsors + single non-nag Support link. Chrome Web Store is the **only** committed v1 surface; Firefox/AMO is gated on real MV3 compat, not a free port.
  - **Autofill real-site burn-in.** Verify the v0.5 moat against the top ~50 sites before launch; file regressions into `urlmatch.test.ts`.

- **v0.7 — Pass123 Pro (the convenience layer that funds the project).** Free core stays free forever and source-available; safety features (encryption, BIP39 recovery, autofill, TOTP) are **never** gated. Pro = a **$19 one-time** unlock for convenience/no-server features: multiple vaults, themes, word-list packs, bulk ops, custom auto-lock intervals, early access, supporter badge. Soft, honor-based license (Chrome retired in-app payments → Merchant-of-Record checkout, Lemon Squeezy default). See `docs/business/MONETIZATION.md`.

- **v0.8 — Per-secret emergency access (the signature differentiator).** Every manager dumps the *whole* vault to a trusted contact; the gap is sharing *one secret at a time, per-recipient, on a timer*. **Committed scope is the no-server, user-mediated capsule** — export a single secret as a time-boxed, separately-encrypted capsule (its own passphrase, expiry baked in, revocable by not sharing the key) that the user hands off through any channel they already trust. This needs **no** server, so it ships here ahead of the watch-list and doesn't wait on Sync. The optional self-hosted/E2E **relay** delivery (automatic timer-based release) is a later enhancement parked in the watch-list, gated on Sync existing. This is the feature no competitor ships; it's the reason to choose Pass123 beyond subtraction.

- **v0.9+ — Watch-list (deferred; commit only on demand/retention signal).** Each is a real bus-factor/scope risk for a solo maintainer — pull in one at a time, never speculatively.
  - **Optional E2E Sync** — zero-knowledge relay, **$2.49/mo or $24/yr**, the *only* justified server. The biggest burnout accelerant; keep opt-in and deferred until the core proves retention. If Sync ever threatens the core, pause Sync, not the extension.
  - **Passkey-first storage** — the #1 2026 buyer priority, but local-only passkey storage is technically thorny and we'd be late. Watch the spec; don't lead with it.
  - **Breach checks** — HIBP k-anonymity (range query, no full hash leaves the device) — the one cloud call compatible with "nothing to breach."
  - **Relay delivery for emergency access** — automatic timer-based release of a v0.8 capsule via the self-hosted/E2E relay. Only meaningful once Sync exists; the user-mediated capsule (v0.8) already covers the no-server case.

- **v1.0 — Definition of done.** Published on the Chrome Web Store; v1→v2 migration proven safe under test; recovery (phrase + emergency kit) verified end-to-end; autofill green on the top-50 real-site table; Pro live. 1.0 is *shipped + recoverable + autofills the hard forms* — not feature-maximal.

> Honest caveat (unchanged): a local manager protects against *casual access to stored data*, not a compromised OS or keylogger. Keep this in marketing — the credibility is the point.

## Open Questions

- KDF choice: Argon2id (stronger, needs WASM) vs PBKDF2 (built into Web Crypto)?
- Export format and how to make backups safe yet recoverable?
- How to handle the MV3 service-worker termination without forcing frequent re-unlock?
