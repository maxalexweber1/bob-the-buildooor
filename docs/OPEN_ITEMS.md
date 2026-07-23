# Open Items

Tracking list for outstanding work, upstream PRs, and local patches that need to be unwound
once fixed upstream. Keep entries short; link to the detailed doc where one exists.

## Upstream fixes (`@harmoniclabs/*`)

**2026-07-18 status:** we are on buildooor **0.2.9** / cardano-ledger-ts **0.5.6** (published
2026-07-17). Items 1–3 + 5 of the old 0.5.1 patch **shipped upstream** (PR #19/#20) and were dropped;
`keepRelevant` (item 4, PR #12) shipped too, but we keep our own `coinSelect.ts` **by choice** (see
its header: ADA-only preference for CIP-113, rising per-input fee bar, sorted top-up). The remaining
patch is `patches/@harmoniclabs+cardano-ledger-ts+0.5.6.patch` — a single fix (item 6) in four files.

| # | Item | Upstream link | Status | Notes |
|---|------|---------------|--------|-------|
| 1 | `AuxiliaryData` `TxMetadata` import → `eras/common` (dual-class) | [PR #20](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/20) | ✅ shipped in 0.5.6 | Patch hunk dropped 2026-07-17. |
| 2 | `AuxiliaryData` Conway aux_data fields optional | [PR #19](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/19) | ✅ shipped in 0.5.6 | Guarded by `test/auxDataPatch.test.ts`. Regression tests not upstream yet (candidate test-only PR, sitting in the fork untracked). |
| 3 | `TxBody` `Certificate` import → `eras/common` (dual-class) | [PR #20](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/20) | ✅ shipped in 0.5.6 | Conway certs recognized; T6.2 verified on-chain (see below). |
| 4 | buildooor `keepRelevant` over-selects | [PR #12](https://github.com/HarmonicLabs/buildooor/pull/12) | ✅ shipped in 0.2.9 | We keep `src/core/tx/coinSelect.ts` deliberately — decision recorded in its header comment. |
| 5 | `AuxiliaryData.fromCborObj` v3-field off-by-one + `toJson` v2/v3 mislabel | [PR #19](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/19) | ✅ shipped in 0.5.6 | Patch hunk dropped 2026-07-17. |
| 6 | `totCollateral` guard inverted — valid values silently dropped (now in **4** TxBody copies) | [PR #21](https://github.com/HarmonicLabs/cardano-ledger-ts/pull/21) | **submitted** 2026-07-18 | Carried in `patches/…+0.5.6.patch` until released. Regression: `test/collateral.test.ts` + fork test. |
| 7 | `TxBody` rejects the package's own exported cert classes (certs dual-class: index exports legacy `dist/ledger/certs`, guard checks `eras/*`) | reported to maintainer (message sent 2026-07-18) | awaiting direction (shims vs structural guards) — offered to PR either | Workaround: build certs via `TxBuilder` (normalizes into the expected copy); pinned in `test/cip30.test.ts`. |
| 8 | buildooor `buildSync` minFee misses the vkey-witness bytes of `requiredSigners` → `FeeTooSmallUTxO` (live: supplied 228189 < expected 230432) | **not yet reported** | open | Worked around by the two-pass fee in `src/core/cip113/transfer.ts`. Report upstream with the live numbers. |

### About `patches/@harmoniclabs+cardano-ledger-ts+0.5.6.patch`

Same patch-package mechanics as before (compiled `dist/` JS, filename pins the exact version,
applied inline in `dev`/`build`/`test` because `ignore-scripts=true` blocks `postinstall` — after a
fresh `npm ci`, run `npm run patch` once). Contents now: **only item 6** — the missing
`throw` in the `totCollateral` guard, in `dist/tx/body/TxBody.js` plus the Babbage/Conway/Dijkstra
era copies. Delete the whole file when PR #21 ships in a released version.


## Unfinished tasks (from EXECUTION_PLAN)

- [x] **T6.2 (remaining)** — ✅ **verified on-chain 2026-07-17**: Conway stake-registration +
      vote-delegation built, decoded (`summarizeTx`) and signed through the wallet path, confirmed on
      preview — tx `35806f030bc8a3e42c6c1f03143ee27ef377859d9a794ed0a52adc90ac139ad5`. Signing-key
      curation pinned by `test/cip30.test.ts` ("NEVER the DRep key").
- [x] **T7.3 — e2e tests (Playwright).** ✅ 9 specs green (wallet lifecycle, vault-at-rest, dApp
      enable/reject, send §1.5 CBOR match, signData COSE verify, test-dApp smoke) — `npm run e2e`.
- [ ] **T6.3 — Ledger (WebHID)** / **T6.4 — Trezor**: code shipped (`f860b31`), but **live device
      verification still pending** (needs physical hardware).
- [x] **T6.5 — CIP-103 bulk signing** — ✅ **verified in the browser on preview 2026-07-23**: a chained
      batch (tx#2 spending tx#1's not-yet-submitted output) signed through ONE approval and both txs
      submitted in order via `cip103.submitTxs`; a same-input (competing) batch returned two witness
      sets; declining returned no witnesses at all. The chain proof: tx#2 was built against ref
      `e8ef5cc2882d…#0` *before* submission and tx#1
      came back from the node as `e8ef5cc2882d7bd7…` — the wallet computed the future tx id and
      resolved the in-batch output correctly. Full hashes to pin on the next run (the harness now logs
      untruncated hashes + explorer links). Checklist: `docs/VERIFY.md` 4.13–4.15.

Deferred (post-v1 / nice-to-have):

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
