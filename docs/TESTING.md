# Testing (T7.3)

Three layers, per CLAUDE.md §7. Unit is the default and the gate; integration is testnet-only; e2e
runs the built extension in Chromium via Playwright (plus the manual checklist in `docs/VERIFY.md`).

## Unit (default, CI gate) — 37 files / 362 tests, all green

`npm run test` (vitest). Covers the security-critical pure logic:

- **Crypto / keys:** `crypto`, `keys`, `mnemonic`, `vault` — KDF round-trips, BIP39/CIP-1852 known
  vectors, AES-GCM encrypt→decrypt, vault tamper rejection.
- **Address / tx:** `address`, `balance`, `tx`, `coinSelect`, `collateral`, `plutusBuild`,
  `plutusData`, `summary`, `history` — derivation, value math, coin selection, Plutus build/eval,
  decode-before-sign (mint/withdrawal decode), and tx-history net-delta.
- **COSE / CIP-30:** `cose` (CIP-8 sign↔verify), `cip30`, `cip30Select`, `errors` — shapes + codes.
- **Bridge / connectivity security:** `senderTrust`, `allowlist`, `approvals` (concurrent-prompt
  isolation), `origin` (opaque-origin guard), `messages`, `discovery`, `provider`.

Any change touching keys, signing, or the message bridge must add/extend a unit test (CLAUDE.md §7).

## Integration (testnet only, run on demand)

Empirical proof scripts under `scripts/` validate the buildooor recipes and real on-chain flows on
**preview** (never mainnet). They use a provider key from the environment, not committed. The
`scripts/` directory is **local dev tooling and is gitignored** (not part of the shipped repo).

- `test-send-fee.cjs` — build/sign/submit a plain ADA send; confirms auto-fee is accepted on-chain.
- `plutus-lock.cjs` / `plutus-spend.cjs` — lock to a script address (inline datum) then spend.
- `plutus-collateral.cjs` — collateral selection.
- `plutus-mint.cjs` — Plutus mint.
- `plutus-refscript.cjs` — CIP-33 reference-script deploy + spend.
- `verify-plutus-eval.cjs` — Ogmios `evaluateTransaction` cost agreement.

Confirmed preview tx hashes are recorded in the build history (spend `c8ccca0f…`, mint `3353511e…`,
ref-script spend `461468ec…`).

**CIP-113 programmable-token transfer (T9.4) — on-chain proof via a self-deployed world.**
`scripts/cip113-deploy.cjs` deploys a CIP-113-shaped fixture on preview (always-succeeds validators,
registered script stake creds, a real registry-node + params UTxO, 1000 TEST113 at the wallet's
programmable address) and emits the `cip113Params` to activate in the wallet;
`scripts/cip113-transfer.cjs` mirrors `core/cip113/transfer.ts` and submits a real transfer.
**Confirmed (tx `9d13443c…`): 100 TEST113 moved sender→recipient across programmable addresses
(1000→900 / 0→100).** Proves the ledger accepts the transfer shape (script spend + both
withdraw-zero + reference inputs + collateral + phase-2). Caveat: the stand-in validators
always-succeed, so upstream's real redeemer/datum encodings still need the audited CF contracts.

## E2E (Playwright, no real network)

`npm run e2e` — builds `dist/` and drives the REAL extension in Chromium (`e2e/`, persistent context
with `--load-extension`, a fresh profile per test so chrome.storage starts empty). Eight specs:

- **Network-free** (`wallet.spec.ts`, `dapp.spec.ts`): wallet lifecycle (restore → lock → wrong
  password → unlock), the **vault-at-rest invariants** (no mnemonic/password anywhere in
  chrome.storage.local; `localStorage` unused — §1.1/§1.2 asserted against the actual profile), the
  onboarding backup gate, and the dApp bridge on a route-fulfilled fake origin: provider injection
  identity, first-`enable()` approval popup showing the real origin (§1.6), grant persistence (no
  re-prompt), rejection → `APIError Refused (-3)`.
- **Mock-provider** (`send.spec.ts` + `mockKoios.ts`): extension-SW fetches aren't
  Playwright-routable, so a local Koios-shaped HTTP mock (permissive CORS — localhost needs no host
  permission) serves params/UTxOs and records submits. Covers the full §1.5 send path — form →
  decoded review → approve → the mock's captured CBOR is decoded in Node and must match what was
  approved (recipient, amount, funding input), with the single vkey witness **cryptographically
  verified** against the wallet's payment key over the body hash — and dApp `signData` with its
  per-call approval (§1.4), the returned COSE_Sign1 verified against the wallet key and payload.

- **Test-dApp smoke** (`testdapp.spec.ts`): serves the BUILT test dApp (`dist-dapp/`, from
  `npm run build:dapp`) from a fake origin so the content script injects the provider, then drives
  the real harness — provider detection, `enable()` approval, `getBalance` — against the mock chain.

Still manual: hardware-device flows, and the interactive **test dApp** write flows (send/mint/burn),
which need real preview chain data + a funded wallet with collateral — `npm run dev:dapp` →
http://localhost:5180, checklist in `docs/VERIFY.md` §4.

