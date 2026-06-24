import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

// MV3 manifest — see docs/IMPLEMENTATION_PLAN.md §4.
// Strict CSP (`script-src 'self'`, no 'wasm-unsafe-eval') is only possible because the
// crypto/tx stack is pure-JS (buildooor). Do NOT add 'wasm-unsafe-eval' without revisiting
// the KDF decision in EXECUTION_PLAN T1.1.
export default defineManifest({
  manifest_version: 3,
  name: 'bob-the-buildooor',
  version: pkg.version || '0.0.0',
  description: pkg.description,

  action: {
    default_popup: 'src/popup/index.html',
    default_icon: {
      '16': 'src/assets/icon-16.png',
      '48': 'src/assets/icon-48.png',
      '128': 'src/assets/icon-128.png',
    },
  },

  // Onboarding/backup happens in a full tab (room to show the 24-word seed safely), not the popup.
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content.ts'],
      run_at: 'document_start',
    },
  ],

  // CIP-30 injection needs no host_permissions; <all_urls> on the content script suffices.
  permissions: ['storage', 'unlimitedStorage', 'idle', 'alarms'],

  // Chain-data providers are fetched from the service worker. Without an explicit host grant, MV3
  // subjects those fetches to CORS — Blockfrost sends `Access-Control-Allow-Origin: *` so it works,
  // but Koios does not reliably, so its requests get blocked. Grant the PUBLIC provider hosts here so
  // they work out of the box. A self-hosted/custom Koios or Ogmios host is requested at RUNTIME from
  // the Provider settings (chrome.permissions.request on Save), keeping the default install minimal
  // (CLAUDE.md §7). These are read-only data endpoints — no key material is ever sent to them.
  host_permissions: ['https://*.koios.rest/*', 'https://*.blockfrost.io/*'],
  optional_host_permissions: ['https://*/*', 'http://*/*'],

  content_security_policy: {
    // script-src 'self' (no wasm-unsafe-eval — pure-JS stack) is the core structural defense.
    // frame-ancestors 'none' hardens against clickjacking of the approval/unlock pages.
    extension_pages: "script-src 'self'; object-src 'self'; frame-ancestors 'none';",
  },

  icons: {
    '16': 'src/assets/icon-16.png',
    '48': 'src/assets/icon-48.png',
    '128': 'src/assets/icon-128.png',
  },
});
