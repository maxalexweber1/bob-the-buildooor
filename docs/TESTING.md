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

## E2E (Playwright, network-free)

`npm run e2e` — builds `dist/` and drives the REAL extension in Chromium (`e2e/`, persistent context
with `--load-extension`, a fresh profile per test so chrome.storage starts empty). Six specs cover
the wallet lifecycle (restore → lock → wrong password → unlock), the **vault-at-rest invariants**
(no mnemonic/password anywhere in chrome.storage.local; `localStorage` unused — §1.1/§1.2 asserted
against the actual profile), the onboarding backup gate, and the full dApp bridge on a
route-fulfilled fake origin: provider injection identity, first-`enable()` approval popup showing
the real origin (§1.6), grant persistence (no re-prompt), and rejection → `APIError Refused (-3)`.

Deliberately network-free: no provider credentials, chain fetches fail gracefully. dApp
signTx/signData e2e would need a mockable chain provider (extension-SW fetches aren't
Playwright-routable) — the candidate approach is pointing the Koios provider at a local mock server.

