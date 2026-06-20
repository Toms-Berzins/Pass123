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
