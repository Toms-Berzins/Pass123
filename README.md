# Pass123 — the password manager with nothing to breach

**Free. Local-only. Open source.** Your vault is AES-256-GCM encrypted and lives only on your device — there's no server to hack, no account to lock you out, and no subscription to dread. Generate strong passwords, autofill logins, store TOTP codes, and keep everything behind one master password that never leaves your machine.

> **We're honest about what this protects.** Pass123 secures your stored credentials against casual access to your data. It is **not** a defense against a fully compromised computer, malware, or a keylogger — no password manager is. If that honesty is what you've been looking for, you're in the right place.

No account · No cloud · No subscription · No ads · No data sale · No telemetry.

See [`IDEA.md`](./IDEA.md) for the concept and roadmap, and [`docs/PRIVACY.md`](./docs/PRIVACY.md) for the (very short) privacy policy.

## Why local-only

- **Nothing to breach.** There is no Pass123 server, so there is no central vault for an attacker to steal and no vendor for you to trust with your secrets.
- **No account, no lock-out.** Your master password is the only key. If you forget it, a 12-word [BIP39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki) recovery phrase (set up at your option) gets you back in — there's no "reset" backdoor precisely because a backdoor is a liability.
- **Open and auditable.** Everything that matters about a password manager is *how* it handles your secrets. You don't have to take our word for it — read the code.

## Features

- 🔐 **Encrypted local vault** — AES-256-GCM, keys derived with Web Crypto (PBKDF2-SHA256, 310k iterations). Ciphertext only ever touches disk.
- 🎲 **Password & passphrase generator** — unbiased CSPRNG passwords (rejection-sampled) with live entropy/strength, plus diceware-style BIP39 passphrases.
- 🧩 **Autofill** — detects login fields (including inside cross-origin iframes) and fills on request; offers to save or update credentials when you submit a login.
- 🔑 **Recovery phrase** — optional 12-word BIP39 phrase + printable emergency kit, so "no account" never means "no way back in."
- 🕑 **TOTP / 2FA codes** — RFC 6238 one-time codes stored as just another encrypted field; the secret never reaches the page.
- 👆 **Biometric / WebAuthn unlock** — optional platform-authenticator unlock via the WebAuthn PRF extension.
- 📦 **Encrypted import/export** — portable, self-describing backup files under a separate export password.
- ⏲️ **Idle auto-lock** — drops the in-memory key after inactivity; an evicted MV3 worker re-locks by design.

## How it works

The security boundary is one rule: **the decryption key and your plaintext exist only in the background service worker's memory. Everything on disk is ciphertext.**

| Layer | File | Responsibility |
|---|---|---|
| Service worker | `src/background.ts` | Holds the session key + plaintext **only in memory**; routes all messages; auto-locks after idle |
| Crypto | `src/lib/crypto.ts` | Web Crypto only — PBKDF2 / HKDF → AES-256-GCM |
| Vault | `src/lib/vault.ts` | Key-wrapping model: one random vault key, *wrapped* per unlock method (password / recovery / biometric) |
| Storage | `src/lib/storage.ts` | `chrome.storage.local` — **ciphertext only** |
| Generator | `src/lib/generator.ts` | CSPRNG passwords + passphrases + entropy/strength |
| Recovery | `src/lib/bip39.ts` | 12-word BIP39 phrase ↔ entropy |
| 2FA | `src/lib/totp.ts` | RFC 6238 TOTP engine |
| Autofill | `src/lib/urlmatch.ts`, `src/content.ts` | Registrable-domain matching + fill/capture |
| Messaging | `src/lib/messages.ts` | Typed request/response protocol |

### Security model

- Your **master password is never stored.** On unlock, a key is derived from it and held only in the service worker's memory.
- The vault uses a **key-wrapping model**: a single random 256-bit vault key encrypts your data, and that key is separately *wrapped* for each unlock method you enable (master password, recovery phrase, biometrics). Adding recovery or biometrics never re-encrypts your data.
- `chrome.storage.local` contains only the wrapped keys and the AES-GCM ciphertext (with its IV + auth tag). No plaintext, ever.
- A **wrong master password** just fails the AES-GCM auth tag — there is no separate password check to attack.
- An MV3 service worker can be evicted when idle; that drops the in-memory key and re-locks the vault **by design**.
- **Threat model:** protects stored data from casual local access. It does **not** defend against a compromised OS, malware, or a keylogger. ([Full privacy policy →](./docs/PRIVACY.md))

> **Navigating the code:** the repo can build a [graphify](https://github.com/safishamsi/graphify) knowledge graph of the codebase (`/graphify .` → the gitignored `graphify-out/`). Open `graphify-out/graph.html` for an interactive map or `GRAPH_REPORT.md` for the tour.

## Stack

- **Manifest V3** + **TypeScript**
- **Vite 8** with the **[CRXJS](https://crxjs.dev) plugin** (HMR for popup, content & background)
- **Web Crypto API** for all cryptography — no third-party crypto libraries

## Develop

```bash
npm install      # install dependencies
npm run dev      # Vite with HMR; writes a dev build to dist/
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select the `dist/` folder

The popup and content scripts hot-reload while `npm run dev` runs.

## Build, test & package

```bash
npm run typecheck   # tsc --noEmit
npm test            # run unit tests (Vitest)
npm run test:watch  # tests in watch mode
npm run build       # type-check + production build into dist/
npm run icons       # regenerate the action icons (public/icons/*.png)
npm run zip         # build, then zip dist/ → pass123.zip (for the Web Store)
```

Unit tests live next to the code (`src/**/*.test.ts`) and cover the pure logic — crypto round-trips, the vault lifecycle, password generation, BIP39, TOTP, URL matching, and backup. They run in Node with global Web Crypto; `chrome.storage.local` is stubbed in-memory (`test/setup.ts`). Run one file with `npx vitest run src/lib/crypto.test.ts`.

## License & support

Source-available and free forever. If Pass123 saves you from a cloud you didn't trust, you can support a solo maintainer via the **Support** link in the extension settings or [GitHub Sponsors](.github/FUNDING.yml) — there's no company, no investors, and no data sale behind this project.
