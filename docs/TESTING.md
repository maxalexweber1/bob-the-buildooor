# Testing (T7.3)

Three layers, per CLAUDE.md §7. Unit is the default and the gate; integration is testnet-only; e2e
needs a real browser and is run by a human.

## Unit (default, CI gate) — 20 files / 145 tests, all green

`npm run test` (vitest). Covers the security-critical pure logic:

- **Crypto / keys:** `crypto`, `keys`, `mnemonic`, `vault` — KDF round-trips, BIP39/CIP-1852 known
  vectors, AES-GCM encrypt→decrypt, vault tamper rejection.
- **Address / tx:** `address`, `balance`, `tx`, `coinSelect`, `cip30Select`, `collateral`,
  `plutusBuild`, `plutusData` — derivation, value math, coin selection, Plutus build/eval shapes.
- **COSE / CIP-30:** `cose` (CIP-8 sign↔verify), `cip30`, `errors` — message shapes and exact CIP-30
  error codes.
- **Bridge security:** `senderTrust`, `allowlist`, `messages`, `discovery`, `provider` — trusted-sender
  discrimination, origin allowlist, message validation.

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

## End-to-end (Playwright, **needs a browser — human-run**)

Not yet automated; cannot run headlessly in this environment (MV3 service-worker e2e needs a real
Chromium with the unpacked extension loaded). Plan when picked up:

1. Add `@playwright/test` as a dev dependency (weigh per CLAUDE.md §2).
2. Launch persistent context with `--load-extension=dist` + `--disable-extensions-except=dist` after
   `npm run build`.
3. Cover the critical user paths: onboarding (create → confirm seed subset → set password),
   lock/unlock across a forced service-worker restart, send-review screen renders the decoded summary,
   and a CIP-30 connect+sign approval flow against a stub dApp page.
4. Run in CI with `xvfb` (Linux) headed mode.

Until then, these paths are verified manually on a `npm run dev` build (see `docs/STORE.md` submission
checklist).
