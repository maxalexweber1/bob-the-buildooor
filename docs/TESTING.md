# Testing (T7.3)

Three layers, per CLAUDE.md §7. Unit is the default and the gate; integration is testnet-only; e2e is
checked manually against a loaded build (see `docs/VERIFY.md`).

## Unit (default, CI gate) — 24 files / 168 tests, all green

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

