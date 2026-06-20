# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Pass123 is a privacy-first Chrome **Manifest V3** extension for local, encrypted password storage and generation. No servers — the vault is AES-256-GCM encrypted behind a master password and lives only in `chrome.storage.local`. See `IDEA.md` for the concept/roadmap.

## Commands

```bash
npm install      # install deps
npm run dev      # Vite + CRXJS dev build with HMR (load dist/ as unpacked)
npm run typecheck # tsc --noEmit
npm run build    # typecheck + production build to dist/
npm test         # vitest run (unit tests in src/**/*.test.ts)
npm run test:watch
npm run icons    # regenerate public/icons/*.png from scripts/gen-icons.mjs
npm run zip      # build + zip dist/ -> pass123.zip
```

Run a single test file: `npx vitest run src/lib/crypto.test.ts`. Filter by name: `npx vitest run -t "wrong password"`.

Load in Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `dist/`.

Toolchain: TypeScript + Vite 8 + `@crxjs/vite-plugin` 2.7, tested with Vitest 4. CRXJS reads `manifest.config.ts` (via `defineManifest`) and auto-generates `dist/manifest.json`, the service-worker loader, and web-accessible resources — never hand-edit `dist/`. Icons are generated PNGs (no design source); edit `scripts/gen-icons.mjs` and rerun `npm run icons` to change them.

Tests run in Node (config: `vitest.config.ts`, no CRXJS plugin) using global Web Crypto. `test/setup.ts` stubs `chrome.storage.local` with an in-memory map, so `vault.ts`/`storage.ts` are testable without a browser. The popup/content/background contexts aren't unit-tested — verify those by loading the extension.

## Architecture

The security boundary is the key rule: **the derived CryptoKey and decrypted entries exist only in the background service worker's memory.** Everything on disk is ciphertext.

- `src/background.ts` — the only context holding `sessionKey` (a non-extractable AES-GCM key) and plaintext. Routes all `Request` messages, persists via the vault layer, and auto-locks after 5 min via `chrome.alarms`. An evicted MV3 worker drops the key and re-locks by design.
- `src/lib/crypto.ts` — Web Crypto only: PBKDF2-SHA256 (310k iters) → AES-256-GCM. No third-party crypto.
- `src/lib/vault.ts` — `VaultEntry`/`VaultData` model + create/unlock/load/save. Unlock = decrypt; a wrong password throws on the GCM auth tag (no separate password check).
- `src/lib/storage.ts` — `chrome.storage.local` wrapper holding only `{ salt, iterations, payload(ciphertext) }`.
- `src/lib/generator.ts` — CSPRNG password generation (rejection-sampled, unbiased) + entropy/strength.
- `src/lib/messages.ts` — typed `Request`/`Response` protocol; all popup/content ↔ background traffic goes through `sendMessage`.
- `src/lib/settings.ts` — non-secret preferences (auto-lock minutes, capture toggle, clipboard-clear seconds) stored **unencrypted** in `chrome.storage.local`, separate from the vault. `getSettings` merges over `DEFAULT_SETTINGS` and clamps. The background caches settings and stays in sync via `chrome.storage.onChanged`; the popup reads/writes them directly (no message round-trip).
- `src/popup/popup.ts` — vanilla-TS view router (setup → unlock → generate/vault tabs). Talks only via messages; never touches crypto or storage directly.
- `src/content.ts` — login autofill (popup → content) **and** capture-on-submit. On a login submit it sends credentials to the background, which decides save/update/none via `captureDecision`; the offer surfaces as a closed-shadow-DOM banner. Captured passwords live only in this isolated content world and the background's memory — never in the page DOM, never sent back to the page.

Capture survives navigation by holding the pending credential in the **service worker's memory** (a `pending` map, 2-min TTL, cleared on lock). The post-submit page re-queries `pendingFor` on load and shows the banner. Cross-host redirects (submit on host A, land on host B) are a known gap; same-host and SPA logins work.

When adding a feature that touches the vault, the flow is: add a `Request` variant in `messages.ts` → handle it in `background.ts` → call it from the popup/content script. Keep crypto/storage out of the popup and content script. Pure, vault-touching logic (like `captureDecision`/`matchEntries`) goes in `vault.ts` so it stays unit-testable.

## Knowledge graph

A [graphify](https://github.com/safishamsi/graphify) knowledge graph of the whole codebase lives in `graphify-out/` (gitignored, generated locally — 192 nodes / 360 edges / 13 communities at last build). For "how does X work / what connects to Y / trace the data flow" questions, prefer `/graphify query "<question>"` over a cold search — the graph is already built, so it skips re-extraction. Open `graphify-out/graph.html` for the interactive view, or read `graphify-out/GRAPH_REPORT.md` for god nodes, cross-community bridges, and audit. Rebuild with `/graphify .` (or `/graphify . --update` for an incremental refresh) after substantial code changes. If `graphify-out/` is missing, the graph just hasn't been built in this checkout.

## Codacy MCP rules

These come from `.github/instructions/codacy.instructions.md` (gitignored). Follow them when the Codacy MCP server is available:

- After ANY successful `edit_file`/`reapply`, immediately run `codacy_cli_analyze` (from Codacy's MCP server) for each edited file: `rootPath` = workspace path, `file` = edited file path, `tool` unset. If issues are found, propose and apply fixes. Do not wait to be asked.
- After ANY dependency operation (npm/yarn/pnpm install, edits to `package.json`/`requirements.txt`/`pom.xml`/`build.gradle`), run `codacy_cli_analyze` with `tool` = `"trivy"` and `file` unset. If vulnerabilities are found, stop other work, fix them, then continue.
- Use standard non-URL-encoded filesystem paths for `rootPath`. Only pass `provider`/`organization`/`repository` once this is a git repository.
- Do NOT run analysis for duplication, complexity metrics, or code coverage. Complexity *issues* are fair game; complexity *metrics* are not.
- Do NOT manually install the Codacy CLI (brew/npm/npx/etc.) — if it's missing, just call `codacy_cli_analyze` and let the MCP server handle it.
- If a Codacy tool returns 404 for `repository`/`organization`, offer to run `codacy_setup_repository` (only with user consent), then retry the failed action once.
