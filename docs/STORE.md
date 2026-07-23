# Store Listing — bob-the-buildooor

Notes for an eventual Chrome Web Store / Firefox Add-ons submission. **Not a near-term task** — keep
this light until we actually publish. Icons are done (`src/assets/icon-{16,48,128}.png`) — the 128px
one is also inlined as the CIP-30 `icon` data URI the inpage provider advertises to dApp wallet
pickers (`src/inpage/provider.ts`, guarded by an e2e decode assertion).

## Identity
- **Name:** bob-the-buildooor
- **Summary (≤132):** Self-custody Cardano wallet. CIP-30 dApp connector, native transaction building,
  pure-JS crypto. Your keys never leave your device.
- **Single purpose:** a self-custody Cardano wallet — store keys encrypted on-device, show balances,
  and sign/submit user-approved transactions (including via CIP-30).

## Permission justifications
| Permission | Why |
|---|---|
| `storage` | Encrypted vault + settings, local only. |
| `unlimitedStorage` | Cache chain data without the small default quota. |
| `idle` / `alarms` | Auto-lock timer — bounds exposure of the in-memory unlock key. |
| content script `<all_urls>` | Inject the CIP-30 provider; relay only, holds no keys. |
| `host_permissions` `*.koios.rest` / `*.blockfrost.io` | Read-only provider fetches (else CORS-blocked); no key material sent. |
| `optional_host_permissions` (http/https) | Runtime-only, for a self-hosted provider URL. |

No remote/inline code (CSP `script-src 'self'`, no `wasm-unsafe-eval`). No analytics/telemetry;
outbound traffic only to the user-chosen provider. Data Safety form: collects/shares nothing.

## Before submitting (when we get there)
Screenshots; publish `docs/PRIVACY.md` at a public URL; bump `version`; `npm run build` → zip `dist/`;
for AMO produce a Firefox build (`docs/FIREFOX.md`); verify on a clean Chrome profile.
