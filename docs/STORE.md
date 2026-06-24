# Store Listing — bob-the-buildooor (T7.5)

Copy and metadata for the Chrome Web Store (CWS) and Firefox Add-ons (AMO) submissions. The icons
(`src/assets/icon-{16,48,128}.png`) are produced by `scripts/generate-icons.cjs`. Items marked
**[human]** require a person with store accounts / a running browser and cannot be produced headlessly.

## Identity

- **Name:** bob-the-buildooor
- **Summary (≤132 chars):** Self-custody Cardano wallet. CIP-30 dApp connector, native transaction
  building, pure-JS crypto. Your keys never leave your device.
- **Category:** Productivity (CWS) / Financial & Crypto (AMO)
- **Single purpose (CWS requirement):** A self-custody Cardano wallet: store keys encrypted on the
  user's device, show balances, and sign/submit user-approved transactions, including via the CIP-30
  dApp standard.

## Detailed description

> bob-the-buildooor is a self-custody wallet for the Cardano blockchain. It generates and stores your
> keys **encrypted on your own device** — there is no account, no server, and no telemetry. Your seed
> phrase and private keys never leave your browser.
>
> **Built for safety:**
> - Every transaction is shown to you in plain language — recipients, amounts, fees, tokens, and a
>   warning whenever a transaction also mints, burns, or carries certificates/governance actions. You
>   never approve an opaque blob.
> - Every dApp connection and every signature requires your explicit approval in the wallet's own
>   trusted window.
> - Keys are encrypted at rest with a strong password-derived key (PBKDF2 + AES-256-GCM) and the
>   wallet auto-locks.
> - A strict Content-Security-Policy and a pure-JavaScript crypto stack (no WebAssembly `eval`) keep
>   the attack surface small.
>
> **Features:** create/restore a 24-word wallet · view ADA & native-token balances · send ADA and
> tokens · connect to Cardano dApps (CIP-30) · Plutus smart-contract interactions · choose your own
> chain-data provider (Blockfrost, Koios, or your own Ogmios/Kupo node).
>
> Open source, Apache-2.0 licensed.

## Permission justifications (CWS "single purpose" + AMO review)

| Permission | Why it is needed |
|---|---|
| `storage` | Persist the **encrypted** key vault and user settings locally. No data leaves the device. |
| `unlimitedStorage` | Cache chain data (UTxOs, metadata) without hitting the small default quota. |
| `idle` | Auto-lock the wallet after inactivity to bound exposure of the in-memory unlock key. |
| `alarms` | Drive the auto-lock timer reliably in an ephemeral MV3 service worker. |
| content script on `<all_urls>` | Inject the CIP-30 provider so any Cardano dApp the user visits can request a connection. The script only relays messages; it holds no keys and signs nothing. Signing happens only in the extension's privileged context after explicit user approval. |

**Host/remote code:** none. The extension loads no remote scripts (CSP `script-src 'self'`, no
`wasm-unsafe-eval`). Network requests go only to the blockchain data provider the user configures.

## Privacy / data disclosure (CWS Data Safety form)

- Does the extension collect or use data? **No** personal/usage data is collected or transmitted.
- Data sold or shared with third parties? **No.**
- Privacy policy URL: see `docs/PRIVACY.md` (publish at a stable URL before submission). **[human]**
- The only outbound connections are to the user-chosen chain-data provider, for operations the user
  initiates.

## Assets

- [x] Icons 16 / 48 / 128 px — `src/assets/icon-{16,48,128}.png` (generated, mascot face+helmet on brand blue).
- [ ] **[human]** Marquee/promo tile (CWS 440×280) and screenshots (1280×800 or 640×400): onboarding,
      dashboard/balance, send-review screen, dApp-connect approval, tx-sign approval. Capture from a
      running build (`npm run dev` → load unpacked).
- [ ] **[human]** Short promo video (optional).

## Submission checklist

- [ ] **[human]** Publish `docs/PRIVACY.md` at a public URL; put that URL in both listings.
- [ ] **[human]** Bump `version` in `package.json` from `0.0.0` to a real release (e.g. `1.0.0`).
- [ ] `npm run build`, then zip `dist/` for CWS.
- [ ] **[human]** AMO: produce a Firefox build first — see `docs/FIREFOX.md` (background model and
      `browser.*` namespace differ; not yet ported/verified).
- [ ] **[human]** CWS: register/verify the developer account; complete the Data Safety form using the
      disclosure above; submit for review.
- [ ] **[human]** Verify the production build on a clean Chrome profile before submitting (SW-kill,
      auto-lock, a real dApp connect+sign on preview/preprod).
