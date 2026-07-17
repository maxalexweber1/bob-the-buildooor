// Trezor Connect popup bridge (T6.4). Injected ONLY into connect.trezor.io/9/* (see
// manifest.config.ts) — this is @trezor/connect-webextension's own content script, bundled here via
// the README's "manual injection" option so the extension does NOT need the broad `scripting`
// permission. It relays messages between the Trezor-hosted popup and our service worker; it has no
// access to wallet state and never runs on dApp pages.
import '@trezor/connect-webextension/build/content-script';
