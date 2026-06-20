import { defineManifest } from '@crxjs/vite-plugin'
import pkg from './package.json'

// Convert semver (e.g. 0.1.0-beta.6) into the up-to-four-number form Chrome wants.
const [major, minor, patch, label = '0'] = pkg.version
  .replace(/[^\d.-]+/g, '')
  .split(/[.-]/)

export default defineManifest({
  manifest_version: 3,
  name: 'Pass123',
  description: pkg.description,
  version: `${major}.${minor}.${patch}.${label}`,
  version_name: pkg.version,

  // Public key (the public half of the local packing key, dist.pem) — pins a STABLE
  // extension id across every load: unpacked dev build and packed .crx both resolve to
  // chrome-extension://lneddopfdbfkcpnomchigacekmmpdeia/. This keeps the extension
  // origin constant, which the WebAuthn/biometric flow needs (RP id = extension host)
  // and makes autofill/iframe testing reproducible. Public, safe to commit (the .pem
  // private key is gitignored and never committed). Revisit at Chrome Web Store publish:
  // the Store may assign a different id, in which case swap in the CWS-provided key.
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuD+dSxGd3A5kruA6KC0Ry/qRZfLfCsIBmcJa5trqYYY/oSik8fN9igslBzCYc5csUnQuFVK7P6epP4QnCk8EWTxsQHuayF5AtjQXhX+lGmMXjqKxFv1DaR+lEbSSZpfms6CZCuoXnV1C1OXzQF9UgoJvBUjZWHoOKvkbeMttw7mLlRDwtsbJTe8GO1flI2VXCwrZPwzRpLs437uTHkRkUPbdK01CDHZmPwfFot7IDqeiOLdyDC23XbFMLBa+f9hvXY7P0j8OxUq1DadZfYsUjfYGOJKkP8csgyIFLYitezWyg83DtxsaLBHfFWJQ2HA7bRd5WhrOenBK28cFGNWrfwIDAQAB',

  // Minimal permission set — local storage + on-demand injection into the active tab only.
  permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'clipboardWrite'],

  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },

  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Pass123',
    default_icon: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },

  background: {
    service_worker: 'src/background.ts',
    type: 'module',
  },

  content_scripts: [
    {
      js: ['src/content.ts'],
      matches: ['http://*/*', 'https://*/*'],
      run_at: 'document_idle',
      // Spike 1: inject into sub-frames too, so login forms inside (cross-origin)
      // iframes — embedded SSO widgets, framed sign-ins — get detected and filled.
      // A cross-origin iframe is an isolated world the top frame's JS can't reach,
      // so per-frame injection is the only way in. Cost is bounded: the script is
      // near-inert at idle and the banner/pending round-trips are gated to the top
      // frame (see content.ts), so ad iframes don't add background traffic.
      all_frames: true,
    },
  ],

  // No inline scripts; everything is bundled.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'",
  },
})
