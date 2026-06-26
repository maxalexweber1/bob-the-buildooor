# Open Items

Tracking list for outstanding work, upstream PRs, and local patches that need to be unwound
once fixed upstream. Keep entries short; link to the detailed doc where one exists.

## Upstream fixes (`@harmoniclabs/*`)

Items 1–3 currently live in `patches/@harmoniclabs+cardano-ledger-ts+0.5.1.patch` (patch-package);
item 4 is our own `coinSelect.ts` standing in for buildooor's broken `keepRelevant`. Each should be
dropped once its upstream fix is released in a version we depend on.

| # | Item | Upstream link | Status | Notes |
|---|------|---------------|--------|-------|
| 1 | `AuxiliaryData` `TxMetadata` import → `eras/common` (dual-class `instanceof`) | [PR #20](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/20) (`ab312d8`/`4a563f0`) | **merged** 2026-06-26 — awaiting npm publish | Metadata/memo build threw on every tx. See [PR-tx-metadata-import-fix.md](./PR-tx-metadata-import-fix.md). |
| 2 | `AuxiliaryData` Conway aux_data fields optional (metadata-only parses) | [PR #19](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/19) (`8c766d7`/`bc95c39`) | **merged** 2026-06-26 — awaiting npm publish | `Tx.fromCbor` rejected metadata-only (CIP-20 / label 674) txs. Guarded by `test/auxDataPatch.test.ts`. |
| 3 | `TxBody` `Certificate` import → `eras/common` (dual-class) | [PR #20](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/20) (`ab312d8`) | **merged** 2026-06-26 — awaiting npm publish | Conway certs/voting (T6.2). Same dual-class root cause as #1. |
| 5 | `AuxiliaryData.fromCborObj` off-by-one (`Array(4)`/`i<4`) drops Plutus-v3 aux scripts; `toJson()` maps v2 under the v3 key | [PR #19](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/19) | **merged** 2026-06-26 — awaiting npm publish | Backported into our patch 2026-06-26 alongside #2 (same PR). v3 aux scripts silently lost on decode; `toJson` mislabel. |
| 4 | buildooor `keepRelevant` over-selects (every UTxO → no ADA-only collateral) | [PR #12](https://github.com/HarmonicLabs/buildooor/pull/12) | submitted | Worked around by our own `src/core/tx/coinSelect.ts` (T3.1). |

### About `patches/@harmoniclabs+cardano-ledger-ts+0.5.1.patch`

We do **not** edit our own source for items 1–3 — the bug is in the third-party dependency, so we patch
its *installed* files via [`patch-package`](https://github.com/ds300/patch-package):

- **What it patches.** The shipped, compiled `.js` inside `node_modules/@harmoniclabs/cardano-ledger-ts/dist/…`
  (not a `.ts` — the library only ships built JS). Editing `node_modules/` directly would be lost on the
  next `npm install`; the checked-in `.patch` file is what makes the fix reproducible for CI and every dev.
- **Filename = target + version.** `@harmoniclabs+cardano-ledger-ts` + `+0.5.1` → the patch only applies to
  exactly that version (a guard against silently mis-applying to a different release).
- **Contents.** Five fork-sourced fixes, all minimal: (1) `AuxiliaryData` `TxMetadata` `require()` repoint,
  (2) `AuxiliaryData.fromCborObj` metadata-only precondition relax, (3) `TxBody` `Certificate` `require()`
  repoint, (5a) `fromCborObj` field-array off-by-one `Array(4)/i<4` → `Array(5)/i<5` (read the Plutus-v3
  field), (5b) `toJson()` `plutusV3Scripts` mapping `this.plutusV3Scripts` (was `plutusV2Scripts`). (5a/5b
  are the rest of upstream PR #19, backported 2026-06-26.) See the table above for the matching upstream refs.
- **How it's applied.** `patch-package` is invoked inline at the start of the `dev` / `build` / `test`
  scripts (idempotent, ~1 s). It is **not** wired as a `postinstall` hook because `.npmrc ignore-scripts=true`
  (supply-chain hardening, T7.1) blocks lifecycle hooks — so after a fresh `npm ci`, run `npm run patch`
  (or `npm run postinstall`) once to apply it. patch-package is **dev-only** (`npm audit --omit=dev` clean).
- **When to remove it.** Once each upstream fix is released in a version we depend on, bump the dependency
  and delete that hunk; drop the whole patch file when all three are gone.

## Follow-ups (unwind once upstream lands)

- [ ] Items 1–3 + 5 are **merged on `main`** (PR #19 + PR #20, 2026-06-26) but **not yet published to npm**
      (latest is still 0.5.1; no 0.5.2 tag/release). When the fixes ship in a published version, bump
      `@harmoniclabs/cardano-ledger-ts` and **delete the patch file entirely** (all four hunks are then upstream).
- [ ] When buildooor #4 lands, revert to its `keepRelevant` and delete `src/core/tx/coinSelect.ts` (T3.1).
- [ ] `patch-package` runs inline in `dev`/`build`/`test` (not via `postinstall`) because
      `ignore-scripts=true` (T7.1). Revisit if the supply-chain policy changes.

## Unfinished tasks (from EXECUTION_PLAN)

Needs hardware / live testnet — can't be completed in this environment:

- [ ] **T6.2 (remaining)** — a Conway vote/delegation tx **confirms on testnet** (needs a live wallet
      owning the stake cred). Parse + decode + witness already done & tested.
- [ ] **T6.3 — Ledger (WebHID).** `ledgerjs-hw-app-cardano` + `hw-transport-webhid`; transport outside
      the SW (popup/offscreen does `HID.requestDevice()`, SW re-binds via `getDevices()`).
- [ ] **T6.4 — Trezor (Connect, popup mode).** Account import + signing; document the iframe workaround.

Deferred (post-v1 / nice-to-have):

- [ ] **T6.5 — CIP-103 bulk signing.** Pure add-on via generic dispatch (T6.1); approval must still
      decode **every** tx in the batch (no batch-blind-sign, §1.5). Implement when a target dApp needs it.
- [ ] **T7.3 — e2e tests (Playwright).** Unit ✅ + preview proof scripts ✅; e2e pending.
- [ ] **T7.4 — Firefox port.** Compat audit done; blockers (event-page background, `browser.*`) in `docs/FIREFOX.md`.
- [ ] **T7.5 — Store submission.** Listing/icons/privacy ✅; screenshots + actual submission deferred.
- [ ] **NFT images** — IPFS gateway is a hardcoded `ipfs.io` default (could be a setting); no persistent
      image cache (HTTP cache only); no dedicated handler-gate test (SSRF validation IS tested).

## Future features (out of scope for v1 — need a product decision)

Not bugs or unfinished tasks — larger features deliberately excluded from single-sig v1. Each needs a
go/no-go before any work starts.

- [ ] **Multisig (native-script).** **CIP-1854** (multisig HD derivation, own path) + **CIP-106**
      (multisig connector — *disables* `signTx`/`signData`, replaces them with `submitUnsignedTx` /
      `getCompletedTx`). Architectural, not a flag: separate derivation, script-address handling, and a
      different connector contract. Out of scope for single-sig v1 (IMPLEMENTATION_PLAN §… CIP table).
- [x] **ADA Handle resolution (`$handle` → address).** ✅ Shipped (T8.1). Send recipient field accepts an
      ADA Handle and resolves to the current on-chain NFT holder via `IChainProvider.getAssetAddresses`
      (Blockfrost/Koios) — `core/handle.ts` + `core/cip67.ts` `encodeCip67`. Policy-as-identity guard,
      single-holder check, CIP-25 + CIP-68 (222) name forms, WYSIWYG resolved-address shown for approval.
      Policy id `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a` is network-independent.
      dApp path also shipped: `api.experimental.resolveHandle(handle)` (origin-gated, read-only, returns
      CIP-30 hex address bytes). **Verified live on preprod** via `test/handle.integration.test.ts`
      (gated by `RUN_INTEGRATION=1`, keyless Koios): resolves a real root handle to its single holder
      (cross-checked against `asset_addresses`) and rejects no-holder/never-minted handles. **Follow-up
      (deferred):** an optional external `cf-adahandle-resolver` URL backend (trust boundary — document
      in SECURITY.md).
- [ ] **CIP-104 — account public-key extension.** Proposed; nice-to-have.
- [ ] **More chain backends.** Blockfrost, Koios and Ogmios are wired behind `IChainProvider` today.
      Still open: a Kupo chain-index pairing for Ogmios (UTxO-by-address history) and a future
      `GerolamoProvider` (own node — see memory `gerolamo-provider-path`).
