# bob-the-buildooor

A standalone Cardano **self-custody browser-extension wallet** (CIP-30), built on
[`@harmoniclabs/buildooor`](https://github.com/HarmonicLabs/buildooor).

- **HD wallet** from a BIP39 mnemonic (CIP-1852 derivation), keys encrypted locally, **client-side signing**.
- **dApp connector** as `window.cardano.<name>` (CIP-30 + CIP-8 `signData` + CIP-95 governance).
- **Transactions** via buildooor: ADA, native tokens, **Plutus** (spend/mint), Conway governance.
- **Swappable chain providers** (Blockfrost / Koios / Ogmios) no mandatory custom backend.
- Pure-TS stack, no WASM → strict Manifest V3 CSP (`script-src 'self'`).

## ⚠️ Status — work in progress, unaudited, do not use on mainnet

This is an **active, unaudited implementation**. It has **not** been through an external security
audit or penetration test, and it has **not been used in production**. It is exercised only on the
Cardano **testnets (preview/preprod)** — **do not point it at mainnet or load it with funds you are
not prepared to lose.** A self-custody wallet handles seed phrases and private keys; until it is
audited, treat it as experimental software for development and review only.

## Develop

```bash
npm ci
npm run allow-scripts   # runs only the vetted esbuild build (install scripts are blocked by default)
npm run build           # typecheck + production build → dist/
npm run dev             # watch build; load unpacked dist/ via chrome://extensions (Developer mode)
npm run test            # vitest (unit)
npm run typecheck && npm run lint
```

Supply-chain note: `.npmrc` sets `ignore-scripts=true`; only allow-listed packages
(`package.json` → `lavamoat.allowScripts`) may run install scripts. See [`docs/SECURITY.md`](docs/SECURITY.md).

## Quick links

- Architecture & decisions: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Step-by-step build guide: [`docs/EXECUTION_PLAN.md`](docs/EXECUTION_PLAN.md)
- Security model & review: [`docs/SECURITY.md`](docs/SECURITY.md)
- Testing strategy: [`docs/TESTING.md`](docs/TESTING.md)
- Firefox port plan: [`docs/FIREFOX.md`](docs/FIREFOX.md)
- Store listing & privacy: [`docs/STORE.md`](docs/STORE.md) · [`docs/PRIVACY.md`](docs/PRIVACY.md)
- CIP-30: https://cips.cardano.org/cip/CIP-30
- buildooor: https://github.com/HarmonicLabs/buildooor
