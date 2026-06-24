# Firefox Port (T7.4)

Status: **planned, not yet shipped.** The Chrome (MV3) build is the supported target. This is the
concrete port plan — the changes below plus a verification pass on Firefox — so the work is mechanical
when picked up.

## Compatibility audit (done)

The background/popup/content code uses only these `chrome.*` APIs, all **promise-style** and all with
Firefox equivalents:

`storage.local`, `storage.session`, `runtime.{connect,onConnect,onMessage,sendMessage,getURL,id,openOptionsPage,Port}`,
`alarms.{create,clear,get,onAlarm}`, `idle.onStateChanged`, `windows.{create,onRemoved}`.

The MAIN-world CIP-30 provider is injected via a `<script>` tag pointing at a
`web_accessible_resource` (not `world: "MAIN"`), which works the same in Firefox.

## The two real blockers (require a Firefox build target)

1. **Namespace / promises.** Firefox exposes promise-based APIs on `browser.*`; `chrome.*` in Firefox
   is callback-style. Our code calls `chrome.storage.local.get()` and awaits the result, which only
   resolves on Chrome.
   - **Fix:** introduce a single accessor `const ext = globalThis.browser ?? globalThis.chrome` in a
     shared module and replace direct `chrome.*` references with `ext.*` (a mechanical, codemod-able
     change), **or** add `webextension-polyfill` (a new dependency — weigh against CLAUDE.md §2 before
     adding). The `ext` shim is preferred: no new dependency, and on Chrome it is just `chrome`.

2. **Background model.** Firefox MV3 does not support `background.service_worker`; it uses an event
   page (`background.scripts`). Our background is authored as a service-worker module.
   - **Fix:** emit a Firefox manifest with `background: { scripts: ['<bundled-bg>.js'] }` (and no
     `type: "module"` unless the target Firefox supports module event pages). The background code is
     largely portable, but anything assuming `self`/SW globals must be checked. `@crxjs/vite-plugin`
     targets Chrome, so the Firefox manifest is produced as a **separate build target**, not by
     editing the shared `manifest.config.ts` (that would break the Chrome build).

## Manifest deltas for Firefox

```jsonc
{
  // background.service_worker  ->  background.scripts (event page)
  "background": { "scripts": ["service-worker-loader.js"] },

  // required for stable add-on id and some APIs
  "browser_specific_settings": {
    "gecko": { "id": "bob-the-buildooor@maxalexweber.de", "strict_min_version": "121.0" }
  }
  // content_security_policy.extension_pages: unchanged (same strict CSP)
  // permissions: unchanged; storage.session requires Firefox 115+
}
```

## Other notes

- **Hardware wallets:** WebHID/WebUSB are Chrome-only; Firefox HW support would go through Trezor
  Bridge / WebAuthn paths. Out of scope until HW (T6.3/T6.4) lands at all.
- **Tooling:** use `web-ext run` / `web-ext lint` for local Firefox testing and AMO pre-validation.

## Definition of done

- `ext.*` shim (or polyfill) in place; Chrome build unchanged and green.
- Separate Firefox build target emits an event-page manifest + `browser_specific_settings`.
- Manual verification on Firefox: onboarding, lock/unlock across background restart, send on
  preview/preprod, a CIP-30 dApp connect + sign. `web-ext lint` clean.
