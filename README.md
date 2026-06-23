# bob-the-buildooor

A standalone Cardano **self-custody browser-extension wallet** (CIP-30), built on
[`@harmoniclabs/buildooor`](https://github.com/HarmonicLabs/buildooor).

- **HD wallet** from a BIP39 mnemonic (CIP-1852 derivation), keys encrypted locally, **client-side signing**.
- **dApp connector** as `window.cardano.<name>` (CIP-30 + CIP-8 `signData` + CIP-95 governance).
- **Transactions** via buildooor: ADA, native tokens, **Plutus** (spend/mint), Conway governance.
- **Swappable chain providers** (Blockfrost / Koios / Ogmios+Kupo) — no mandatory custom backend.
- Pure-TS stack, no WASM → strict Manifest V3 CSP (`script-src 'self'`).

## Status

🚧 Pre-implementation. The full build plan lives in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — architecture, tech stack,
security requirements, CIP order, and a phased roadmap (M0–M7).

## Quick links

- Architecture & decisions: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Step-by-step build guide: [`docs/EXECUTION_PLAN.md`](docs/EXECUTION_PLAN.md)
- CIP-30: https://cips.cardano.org/cip/CIP-30
- buildooor: https://github.com/HarmonicLabs/buildooor
