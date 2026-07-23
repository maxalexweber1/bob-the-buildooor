# Execution Plan — How to Build bob-the-buildooor

> Companion to [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) (the *what* — architecture & decisions).
> This is the *how* — an ordered, task-by-task build guide with concrete files, key APIs, and
> "done-when" acceptance criteria. Work milestones top to bottom; tasks within a milestone in order
> unless marked parallel. Check boxes as you go.

**Conventions**
- `done-when:` = objective acceptance criterion (demoable or testable).
- Each task lists the **files** it creates/touches and the **key APIs** involved.
- "Reference: …" points at a file in the ODATANO repo to copy/adapt (not a runtime dependency).
---

## M1 — Keyring & Vault (security core)

Goal: create/restore a wallet, encrypt it, lock/unlock survives SW restarts.

- [x] **T1.1 — Decide KDF** (IMPLEMENTATION_PLAN §14). Pick **PBKDF2 ≥600k via SubtleCrypto** (keeps `script-src 'self'`) *or* Argon2id (accept `'wasm-unsafe-eval'`). Record decision in this file.
  - **DECISION (2026-06-23): PBKDF2-HMAC-SHA256, ≥600,000 iterations, via `crypto.subtle`.** Keeps the strict CSP `script-src 'self'` — **no** `'wasm-unsafe-eval'`, no WASM KDF dependency (honours CLAUDE.md §1.7/§1.9). AES-256-GCM for the cipher. KDF id + iteration count + salt persisted in vault metadata so the parameters can be migrated forward (e.g. raise iterations) without locking out existing vaults.
  - **vs. legacy precedent (standards review 2026-06):** the historical Cardano vault standard is **EMIP-003** (Daedalus/Yoroi) = PBKDF2-HMAC-SHA**512** @ **19,162** iterations + **ChaCha20Poly1305**. We deliberately diverge: AES-256-GCM (native in `crypto.subtle`, no extra dep) and ≥600k iterations (EMIP-003's 19,162 is well below current OWASP guidance). Consequence: **not** EMIP-003 wire-compatible — acceptable because we import by **mnemonic**, never by raw vault blob. Full rationale in IMPLEMENTATION_PLAN §10.1.
  - done-when: decision documented + a `crypto/kdf.ts` interface fixed.
- [x] **T1.2 — Crypto wrapper.** AES-256-GCM encrypt/decrypt, 32-byte salt, ≥12-byte IV, KDF params persisted in vault metadata.
  - files: `src/core/crypto/kdf.ts`, `src/core/crypto/aead.ts`
  - key APIs: `crypto.subtle.deriveKey/encrypt/decrypt`, `crypto.getRandomValues`
  - done-when: unit tests: encrypt→decrypt round-trip; wrong password rejected; tamper (GCM tag) rejected.
- [x] **T1.3 — BIP39 layer.** Generate (256-bit/24-word), validate, mnemonic↔entropy.
  - files: `src/background/keyring.ts`
  - key APIs: `@scure/bip39` `generateMnemonic/validateMnemonic/mnemonicToEntropy` + english `wordlist`
  - done-when: known test vectors (mnemonic↔entropy) pass.
- [x] **T1.4 — CIP-1852 derivation.** `root = XPrv.fromEntropy(entropy)`; `deriveKey(acct,role,idx)` chain with `harden`. Payment/stake/DRep keys.
  - files: `src/background/keyring.ts`, `src/core/address.ts`
  - key APIs: buildooor `XPrv`, `harden`, `Credential.keyHash`, `StakeCredentials.keyHash`, `Address.mainnet/testnet`, `blake2b_224`
  - done-when: derived addr matches a reference wallet (e.g. import the same seed into Eternl testnet, compare addr 0).
- [x] **T1.5 — Vault store.** Encrypted blob → `chrome.storage.local`; never plaintext; never `localStorage`.
  - files: `src/background/vault.ts`
  - done-when: blob persists across reload; decrypted material never written to disk (audited).
- [x] **T1.6 — Lock/unlock across SW death.** Cache derived key (not password) in `chrome.storage.session` (`TRUSTED_CONTEXTS`); re-decrypt on respawn; auto-lock via `chrome.alarms`+`chrome.idle`.
  - files: `src/background/vault.ts`, `src/background/autolock.ts`
  - key APIs: `chrome.storage.session`, `chrome.alarms`, `chrome.idle.onStateChanged`
  - done-when: unlock, force-kill the SW (DevTools → terminate), trigger any action → stays unlocked; after auto-lock timeout → re-prompt.
- [x] **T1.7 — Onboarding UI.** Create (show seed, confirm subset), Restore (paste seed), set password; unlock screen.
  - files: `src/options/Onboarding.tsx`, `src/popup/Unlock.tsx`
  - done-when: full create→lock→unlock→restore loop works manually.

**Milestone exit:** a wallet exists, is encrypted at rest, unlocks ergonomically under MV3 SW churn.

---

## M2 — Provider & Read-Only Wallet

Goal: see balance, UTxOs, assets, history for the derived addresses.

- [x] **T2.1 — Provider interface.** `IChainProvider` per IMPLEMENTATION_PLAN §7.
  - files: `src/background/provider/IChainProvider.ts`
- [x] **T2.2 — Blockfrost impl.** getProtocolParameters/getUtxos/resolveUtxos/getGenesisInfos/submitTx (+ awaitTxConfirmation).
  - files: `src/background/provider/blockfrost.ts`
  - done-when: against preview testnet, returns real UTxOs/params for a funded test address; provider timeout < 30 s (SW-safe).
- [x] **T2.3 — Koios impl (second provider) + selector.** Network + provider chosen in settings.
  - files: `src/background/provider/koios.ts`, `src/background/provider/index.ts`, `src/options/Settings.tsx`
  - done-when: switching provider/network re-derives prefixes and refetches.
- [x] **T2.4 — Address discovery (gap limit 20).** Walk role 0/1 until 20 consecutive unused (usage probed via provider).
  - files: `src/background/keyring.ts`
  - done-when: a multi-address test seed surfaces all used addresses.
- [x] **T2.5 — Balance/asset decoding + dashboard.** Port CBOR `value` decoder + bech32 helpers; render balance, UTxO list, asset summary, tx history.
  - files: `src/core/cbor/value.ts`, `src/popup/Dashboard.tsx`
  - Reference: ODATANO `app/wallet/webapp/service/WalletService.js` (CBOR/bech32/multiasset), `Wallet.controller.js` (history UX).
  - done-when: dashboard matches a block explorer for the test address.

**Milestone exit:** functional watch-only wallet over real testnet data.

---

## M3 — Send & Sign (ADA + native tokens)

Goal: build, sign locally, submit a transfer; show a human-readable approval.

- [x] **T3.1 — Build functions.** Simple ADA, multi-asset, with-metadata via buildooor `TxBuilder` + `keepRelevant`.
  - files: `src/core/tx/build.ts`
  - key APIs: `TxBuilder`, `keepRelevant`, `Value.lovelaces/singleAsset`, validity via genesisInfos
  - Reference: ODATANO `srv/blockchain/cardano-tx-builder.ts`, `transaction-building/buildooor-tx.ts`
  - done-when: produces valid unsigned CBOR; fee within expected range.
- [x] **T3.2 — Local signer.** `tx.signWith(paymentXprv)`; serialize signed CBOR.
  - files: `src/background/signer.ts`
  - done-when: submitted tx confirms on preview testnet.
- [x] **T3.3 — Tx decoder for approval.** Parse CBOR → {inputs, outputs, amounts, fee, mint, metadata, certs} for display.
  - files: `src/core/cbor/decodeTx.ts`, `src/popup/Approve.tsx`
  - Reference: ODATANO `ParseTransactionCbor` handler logic.
  - done-when: approval screen shows correct recipient/amount/fee for crafted txs; **no opaque blob**.
- [x] **T3.4 — Send flow + status polling.** Form → build → approval → sign → submit → poll confirmation.
  - files: `src/popup/Send.tsx`
  - done-when: end-to-end send on testnet, with confirmation surfaced.

**Milestone exit:** self-custody send works with informed approval.

---

## M4 — CIP-30 dApp Connector

Goal: real dApps connect and transact through the wallet.

- [x] **T4.1 — enable() consent + origin allowlist.** First connect opens approval popup; store authorized origins in background.
  - files: `src/background/dapp/allowlist.ts`, `src/background/cip30/enable.ts`, `src/popup/Connect.tsx`
  - done-when: unknown origin prompts; known origin returns API without prompt; `isEnabled()` consistent.
- [x] **T4.2 — Read methods.** getNetworkId/getUtxos(amount?,paginate?)/getBalance/getUsed|Unused|Change|RewardAddresses/getCollateral.
  - files: `src/background/cip30/handlers.ts`
  - done-when: returns hex-CBOR; accepts bech32|hex inputs; pagination + `null` semantics correct.
- [x] **T4.3 — signTx (witness set only!).** Per-call consent; return `transaction_witness_set`, not the full tx; support `partialSign`.
  - files: `src/background/cip30/signTx.ts`
  - Reference: ODATANO `srv/utils/signing-helper.ts` (witness-set shape/merge).
  - done-when: a real testnet dApp (e.g. a faucet/DEX testnet) completes a tx via the wallet.
- [x] **T4.4 — submitTx + error codes.** Wire submit; implement all CIP-30 error codes exactly (IMPLEMENTATION_PLAN §9).
  - files: `src/background/cip30/submit.ts`, `src/shared/errors.ts`
  - done-when: declines/failures surface the correct `{code,info}`.
- [x] **T4.5 — signData (CIP-8 COSE_Sign1).** Build `Sig_structure`, sign with extended Ed25519, return `{signature,key}`; + tx-based login fallback for HW.
  - files: `src/core/cose/sign.ts`, `src/core/cose/verify.ts`
  - Reference: ODATANO `srv/blockchain/signing/cose-verifier.ts` (mirror to produce).
  - done-when: a "Sign-in with Cardano" demo verifies the signature against the address credential.

**Standards-review additions (round 1, 2026-06):**
- [x] **T4.6 — `getExtensions()` + extension negotiation.** CIP-30 conformance gap: `getExtensions()` was missing and `enable()` ignored its `{extensions}` argument. Now `enable({extensions})` negotiates `requested ∩ supported`, persists the granted CIP set per origin, and the inpage provider exposes only the granted extension namespaces; `getExtensions()` reports the negotiated set.
  - files: `src/shared/extensions.ts` (new — supported set + `negotiateExtensions`, trust-no-input), `src/background/dapp/allowlist.ts` (per-origin extensions + legacy `string[]` migration), `src/shared/messages.ts`, `src/background/cip30/handlers.ts`, `src/inpage/provider.ts`
  - done-when: ✅ unit tests — negotiation grants only supported CIPs, `getExtensions()` reflects the grant, malformed args ignored, legacy allowlist migrates. (`test/cip30.test.ts`, `test/allowlist.test.ts`; 180/180 pass.)
- [x] **T4.7 — Generic extension dispatch.** `EXTENSION_REGISTRY` (shared/extensions.ts) is the single source of truth for `{cip, namespace, methods, placement}`; the inpage provider builds the granted extensions' api surface generically from it, the wire type is `cip{N}.{method}`, and the background gates every `cipNN.*` call on the per-origin negotiated set (defends the raw-postMessage bypass of the inpage gating). **Also fixed a CIP-95 conformance bug found in the process:** `getRegisteredPubStakeKeys` is exposed UN-namespaced as `api.getRegisteredPubStakeKeys()` (verified verbatim against CIP-0095/README.md headings — we previously exposed it under `cip95.`).
  - files: `src/shared/extensions.ts` (registry + `extensionCipOf`/`extensionWireKey`), `src/inpage/provider.ts`, `src/background/cip30/handlers.ts`, `src/shared/messages.ts`
  - done-when: ✅ unit tests — registry placement (`test/extensions.test.ts`), extension-not-negotiated → InvalidRequest (-1) gate, negotiated → success (`test/cip30.test.ts`). 189/189 pass, typecheck + lint clean.
- [x] **T4.8 — `getCollateral`/CIP-40 note.** In-code comment marking `getCollateral` deprecated in favour of CIP-40 collateral-output; behaviour unchanged.
- [x] **T4.9 — CIP-20/83 tx message decode.** `core/tx/txMessage.ts` (`decodeTxMessage`) reads metadata label 674 (`msg` lines) and flags CIP-83 encryption (`enc`); wired into `summarizeTx` (`message?`) with the aux-data warning refined to suppress when the only metadata is the decoded memo. Rendered in the signTx approval (`MessageRows`, React text nodes only — CLAUDE.md §8).
  - done-when: ✅ `test/txMessage.test.ts` (9 cases incl. encrypted/malformed). Outbound memo-on-send not built.
- [x] **T4.10 — CIP-67/68 asset-name labels.** `core/cip67.ts` (`parseCip67` — frame + CRC-8/SMBUS validation against the spec vector; `cip67LabelName`); `core/balance.ts` strips the prefix for the display name and exposes `cip67Label`; dashboard + approval show an NFT/FT/RFT/ref badge.
  - done-when: ✅ `test/cip67.test.ts` + extended `test/balance.test.ts`.
- [x] **T4.11 — CIP-25/68 token-name fetch (names; images deferred).** `IChainProvider.getAssetMetadata?` + Blockfrost impl (`/assets/{asset}` → on-chain CIP-25/68 metadata, off-chain CIP-26 registry fallback; chunked-image-array join). Background `getAssetMetadata` command with a persisted, **network-keyed**, 24 h cache (sequential fetch from the dashboard to avoid clobbering the storage read-modify-write). Dashboard prefers the resolved name over the on-chain name.
  - files: `background/provider/IChainProvider.ts` (`AssetMetadata`), `background/provider/blockfrost.ts`, `background/walletHandlers.ts`, `shared/internal.ts`, `shared/walletClient.ts`, `popup/Dashboard.tsx`
  - done-when: ✅ `test/provider.test.ts` (Blockfrost: on-chain, chunked image, off-chain fallback, 404/empty→null; **Koios**: CIP-25 from raw 721, off-chain fallback, empty→null). Shared field pickers in `provider/mappers.ts`. 215 tests; typecheck + lint + build clean.
  - **Koios `getAssetMetadata` ✅** (POST `/asset_info`, raw 721 + off-chain registry). Ogmios/Kupo still omit it (no metadata index).
  - **deferred:** NFT image rendering — next up, needs a CSP `img-src` decision (§1.7) + IPFS gateway + privacy review (chosen approach: background-proxy + tighten CSP).
- [x] **T4.12a — patch the metadata-only aux_data parser bug (unblocks inbound memo signing).** cardano-ledger-ts 0.5.1 `AuxiliaryData.fromCborObj` wrongly rejected metadata-only Conway aux_data, so `Tx.fromCbor` threw on **any** tx carrying just a CIP-20 memo — meaning we could not even parse (let alone sign/decode) such a dApp tx. Fixed via **patch-package** with the exact fix from the user's `cardano-ledger-ts-fork` (`bc95c39` / PR #19): `patches/@harmoniclabs+cardano-ledger-ts+0.5.1.patch`. The patch now carries **three** fork-sourced fixes: (1) AuxiliaryData TxMetadata dual-class repoint (memo build), (2) `fromCborObj` metadata-only relax (memo parse), (3) TxBody Certificate dual-class repoint (Conway certs, T6.2 — from `b68105f`). All three are single-line `require()` repoints / a precondition relax. **Note:** `.npmrc ignore-scripts=true` blocks auto-postinstall → run `npm run postinstall` after install (documented in package.json `comment2`). patch-package is **dev-only** (`npm audit --omit=dev` clean).
  - done-when: ✅ `test/auxDataPatch.test.ts` — a real metadata-only memo tx parses via `Tx.fromCbor` (would throw unpatched) and round-trips through `decodeTxMessage`. 217 tests; typecheck + lint + build clean.
- [x] **T4.12b — outbound CIP-20 memo on send.** The build-time `instanceof` bug (two divergent `TxMetadata` copies) is now **fixed in the patch** (`AuxiliaryData.js` repointed to the eras/common copy that `TxBuilder`/the index use — same fork dual-class pattern as `b68105f`), so buildooor's **native `memo` arg works** — no deep-import needed in our code. `buildSend(ctx, out, { memo })` passes `memo` to `buildSync` (buildooor auto-splits to ≤64 B label-674); `MAX_MEMO_BYTES=256` cap. Wired through `buildSend` command → `Send.tsx` memo field (with a "public & permanent" hint); the review screen + dApp approval render the decoded memo (T4.9).
  - files: `core/tx/build.ts`, `background/walletHandlers.ts`, `shared/internal.ts`, `shared/walletClient.ts`, `popup/Send.tsx`
  - done-when: ✅ `test/tx.test.ts` (memo decodes in summary; long memo splits to 2 lines; over-cap throws; no-memo → no metadata flag). 221 tests; typecheck + lint + build clean. The patch now carries BOTH ledger-ts fixes (fromCborObj relax + dual-class repoint).
- [x] **T4.13 — NFT image display (A2, background-proxy).** The SW fetches CIP-25/68 art and returns a `data:` URI; the popup renders it (dashboard `TokenAvatar`, falling back to the generated avatar). Privacy: only the SW (not the popup) contacts the gateway — same trust surface as the chain provider. The image URI is attacker-controlled metadata → strict validation in `core/assetImage.ts` (ipfs:// + https:// only; SSRF host-allowlist blocking localhost/private/link-local/metadata) + network limits in `background/assetImage.ts` (8 s timeout, `credentials:'omit'`, content-type must be `image/*`, ≤1 MB). **CSP decision (CLAUDE.md §1.7, §10):** added `img-src 'self' data:` — a tightening of the previously-implicit-open directive; the popup never loads a remote image (only self + the SW's data: URIs). `connect-src` left unset (provider/gateway endpoints are user-configurable).
  - files: `core/assetImage.ts`, `background/assetImage.ts`, `background/walletHandlers.ts`, `shared/internal.ts`, `shared/walletClient.ts`, `popup/ui.tsx` (`TokenAvatar` image), `popup/Dashboard.tsx`, `manifest.config.ts`
  - done-when: ✅ `test/assetImage.test.ts` (9 cases: ipfs/https resolve, scheme rejects, SSRF blocks, mime filter). 230 tests; typecheck + lint + build clean; built manifest carries `img-src 'self' data:`.
  - **privacy opt-out ✅** — `WalletSettings.nftImages` (default ON); a "Show NFT images" toggle in `options/Settings.tsx` with the IP/holdings-leak explained. The `getAssetImage` handler gates on it, so when OFF the SW **never contacts the gateway** (token names still show). 
  - **UI integration ✅** — clicking a dashboard asset opens an `AssetDetail` overlay (large art, decoded name + CIP-67 badge, the CIP-25/68 **description** — previously fetched but never shown —, quantity/decimals, policy + asset-name hex); the Send review uses a shared `AssetLine` (decoded name + badge), matching the dashboard. External strings render as text nodes only (§8).
  - **deferred:** IPFS gateway is a hardcoded default (`ipfs.io`), could become a setting; no persistent image cache (HTTP cache only, re-fetched per session); no dedicated handler-gate test (no walletHandlers test harness exists — the gate is a reviewed one-liner; the SSRF validation IS tested).

**Milestone exit:** a third-party CIP-30 dApp works against the wallet on testnet.

---

## M5 — Plutus (full scope)

Goal: spend from and mint via Plutus scripts with correct ex-units.

- [x] **T5.1 — PlutusData JSON ↔ Data.** Datum/redeemer conversion; handle `constr` vs `constructor` key normalization.
  - files: `src/core/tx/plutusData.ts`
  - key APIs: `@harmoniclabs/plutus-data` `Data`, `dataFromCbor/dataToCbor`, `DataConstr`
- [x] **T5.2 — Collateral management.** Ensure ADA-only collateral UTxO (~5 ADA); collateral return.
  - files: `src/core/tx/collateral.ts`
- [x] **T5.3 — 2-pass build with eval.** Pass 1 local CEK; Ogmios `evaluateTx` for authoritative ex-units; stamp redeemer budgets; recompute `scriptDataHash`.
  - files: `src/core/tx/plutusBuild.ts`, `src/background/provider/ogmios-kupo.ts`
  - key APIs: buildooor `getScriptDataHash`, cost models; provider `evaluateTx`
  - Reference: ODATANO `srv/blockchain/transaction-building/buildooor-tx.ts` (the canonical 2-pass impl).
  - done-when: a Plutus V3 spend + a mint both confirm on testnet.
- [x] **T5.4 — Reference inputs / inline datums / reference scripts (CIP-31/32/33).** Round-trip these fields in build + decoder.
  - files: `src/core/tx/plutusBuild.ts`, `src/core/cbor/decodeTx.ts`
  - done-when: a ref-script spend works; approval screen renders script interactions.

**Milestone exit:** Plutus dApp interactions succeed with correct fees/ex-units.

---

## M6 — Governance (CIP-95) & Hardware Wallets

- [x] **T6.1 — CIP-95 extension (COMPLETE).** Negotiate via `enable({extensions:[{cip:95}]})`; `api.cip95.{getPubDRepKey,getUnregisteredPubStakeKeys,signData}` + root `getRegisteredPubStakeKeys` all implemented.
  - files: `src/background/cip30/handlers.ts` (cip95 cases + `signDataCip95`/`stakeKeyRegistered`), `src/background/provider/{IChainProvider,blockfrost,koios,ogmios,ogmios-kupo,composite}.ts`, `src/popup/Connect.tsx` (governance signing banner)
  - key APIs: DRep key `…/3/0` (CIP-105)
  - note: dispatch the `cipNN.` namespace **generically** off `supportedExtensions` (IMPLEMENTATION_PLAN §9), not hard-wired to CIP-95 — so CIP-103/104 drop in without touching the bridge. `getRegisteredPubStakeKeys` stays un-namespaced per spec.
  - **`cip95.signData`:** accepts DRepID (28-byte hex), reward address (bech32/hex — script-cred → AddressNotPK), payment address (falls through to CIP-30 path). Signs with the matching DRep/stake/payment key; approval popup shows an explicit "Governance signing (CIP-95)" banner for DRep/stake signing. Foreign governance credential → ProofGeneration (1). Registered in `EXTENSION_REGISTRY` again.
  - **stake registration is LIVE state:** new `IChainProvider.getStakeRegistration?(stakeAddr)` — Blockfrost `/accounts/{stake}` `active`, Koios `/account_info` `status`, Ogmios `queryLedgerState/rewardAccountSummaries` (entry-presence; Ogmios+Kupo delegates to Ogmios; composite binds primary??secondary). Unknown/unsupported/error → reported unregistered per spec.
  - **remaining (manual):** GovTool smoke test on preview against the live extension (connect → DRep flow) — can't be run headless here.
- [x] **T6.2 — Conway certs/voting in signTx (parse + decode + witness; on-chain confirm pending).**
  - **Unblocked via the patch (b68105f approach, cleanly):** the Conway-cert dual-class turned out to be a single-line repoint, same shape as the memo fix — `dist/tx/body/TxBody.js`'s `Certificate` require → `eras/common/ledger/certs/Certificate.js`, so `certificateFromCborObj` (parse) and `isCertificate` (validate) use the same (Conway-aware) copy. Added to `patches/@harmoniclabs+cardano-ledger-ts+0.5.1.patch` (now 3 fixes). **Verified end-to-end:** a real Conway vote-delegation tx now `Tx.fromCbor`-parses and round-trips (`test/tx.test.ts` — would throw unpatched). (My earlier "certType of undefined" was a red herring — buildSync wants `certificates:[{cert}]`, not `[cert]`.)
  - **Wallet-side decode DONE (anti-blind-sign §1.5):** `core/tx/certs.ts` (`certView`/`decodeCerts`/`decodeGovernance`) → human lines ("Delegate voting power to DRep X", "Register as a DRep (deposit 500 ₳)", …) + governance presence (votes flag + proposal count). Wired into `summarizeTx`; rendered in the signTx approval (`CertRows`/`GovernanceRows`); generic cert/gov warning removed. signTx witnessing offers stake+DRep keys via `flags.certificates/governance`.
  - files: `src/core/tx/certs.ts`, `src/core/tx/summary.ts`, `src/popup/Connect.tsx`, `patches/…` ; tests `test/certs.test.ts` (7) + `test/tx.test.ts` Conway end-to-end. 238 tests; typecheck + lint + build clean.
  - **remaining:** a vote/delegation tx **confirms on testnet** (needs a live wallet owning the stake cred — can't run here). Outbound gov-tx *building* (we don't do it; dApps/GovTool do) would deep-import the `ConwayCert*` classes or add b68105f's barrel re-export.
- [~] **T6.3 — Ledger (WebHID) — IMPLEMENTED (2026-07-17), on-device verification pending.**
  `@cardano-foundation/ledgerjs-hw-app-cardano@8.0.0` + `@ledgerhq/hw-transport-webhid@6.36.0`
  (+ `buffer` polyfill for their Node `Buffer` global), all exact-pinned; prod `npm audit` stays 0.
  - **Architecture (MV3 constraint honoured):** ALL device IO lives in the **options page** (a full
    tab — `HID.requestDevice()` needs a user-gesture page context, and the action popup dies when the
    native chooser steals focus). The SW never touches the transport and never bundles the SDK
    (verified in dist/: the SW chunk has zero SDK references — the SDK lands only in the options
    bundle). Flow: page reads the account xpub → background stores it (watch-only) → background
    builds + decodes → page shows the summary (§1.5) → page drives the device → background VERIFIES
    the witnesses → submits.
  - **Watch-only accounts:** `core/hw/xpubAccount.ts` soft-derives payment/stake keys + base
    addresses from the CIP-1852 account xpub (m/1852'/1815'/0') — no private material in the browser,
    ever. Unit-proven equal to the hot-wallet XPrv derivation. Discovery reuses the gap-limit walk
    via the new `discoverAddresses(addressAt, …)` generalization (`background/discovery.ts`).
  - **Byte-exactness (the HW trap):** the device signs ITS OWN re-serialization of the tx, so the
    request mirrors buildooor's layout — outputs as Babbage MAP format (buildooor always emits
    CborMap outputs), `tagCborSets: false` (buildooor doesn't 258-tag sets). Any drift is caught, not
    submitted: `applyHwWitnesses` (`core/hw/ledgerTx.ts`) requires device-txHash == our body hash,
    exact signer coverage (no missing/extra paths), and every signature to Ed25519-verify against the
    xpub-derived key. Malformed sigs (crypto-layer throws) reject cleanly.
  - **Scope v1:** plain payments (ADA + assets + CIP-20 memo) — exactly what `buildSend` produces;
    `mapTxForLedger` rejects certs/withdrawals/mint/Plutus/collateral/etc. BY NAME
    (`HwUnsupportedError`), never silently drops. dApp CIP-30 `signTx` does NOT route to hardware yet
    (arbitrary dApp txs need the full feature mapping) — a Ledger account is popup-invisible, managed
    entirely in the options tab (list/pair/forget, balance, receive, send). No vault/unlock required
    (a hardware-only user has no mnemonic; the device is the §1.4 consent gate, the page summary the
    §1.5 decode).
  - files (as built): `core/hw/xpubAccount.ts`, `core/hw/ledgerTx.ts` (both pure), `background/hw/accounts.ts`,
    `background/walletHandlers.ts` (hw* commands), `background/discovery.ts`, `shared/internal.ts`,
    `shared/walletClient.ts`, `options/ledgerDevice.ts` (SDK boundary), `options/nodeBuffer.ts`,
    `options/Ledger.tsx`, `options/Options.tsx` (tab)
  - tests: ✅ `test/hw.test.ts` (14 device-free cases — the "device" is the same seed's XPrv:
    xpub↔XPrv derivation equality, xpub validation, payload mapping incl. paths/change/aux-hash,
    unsupported-feature rejection, witness gate: valid/tampered/wrong-path/missing/extra/replayed-
    from-other-tx, hash mismatch). 358 tests; typecheck + lint + build clean.
  - **remaining (needs the physical device):** pair a real Ledger on preview, send, confirm on-chain
    (done-when). First candidates if the device rejects: Cardano app version vs `tagCborSets`
    expectations, and the MAP_BABBAGE output format on very old app versions.
- [~] **T6.4 — Trezor (Connect) — IMPLEMENTED (2026-07-17), on-device verification pending.**
  `@trezor/connect-webextension@9.7.3` (exact-pinned). The old iframe workaround is obsolete — this
  package is Trezor's official MV3 path: the SDK runs in OUR SERVICE WORKER (its supported context —
  the inverse of Ledger's page-side WebHID) and opens the Trezor-hosted popup (connect.trezor.io),
  which does all device IO on Trezor's origin. Wiring uses the README's "manual content-script
  injection": `src/content/trezorConnect.ts` (bundling Trezor's own relay) declared in the manifest
  for `*://connect.trezor.io/9/*` ONLY — chosen over the broad `scripting` permission on purpose.
  - **Shares the whole T6.3 stack:** same watch-only xpub accounts (`cardanoGetPublicKey` node →
    publicKey‖chainCode), same discovery, same `buildSend`, same neutral signing payload (extended
    with `addressBech32` — Trezor consumes bech32, Ledger hex), same `applyHwWitnesses` gate. One
    generalization: Trezor identifies witnesses by PUBKEY instead of BIP32 path — matching accepts
    either, and the signature is ALWAYS verified against our xpub-derived key for the matched signer
    (a device-claimed pubkey is never trusted on its own).
  - **Byte-exactness:** same constraints pinned as Ledger — `format: MAP_BABBAGE` per output,
    `tagCborSets: false`. Enum values are compile-checked against `PROTO` via type-only imports
    (the package's prebuilt UMD `main` exports only the default object — a value import of PROTO
    would be undefined at runtime; its `types` field is also broken → shimmed in
    `src/types/trezor-connect-webextension.d.ts`, re-check on bump).
  - **Accepted audit deviation (human-approved 2026-07-17):** the dep makes `npm audit --omit=dev`
    red (`elliptic`, no fix, via Trezor's popup-side blockchain-link) — but that code provably never
    ships: dist/ contains zero elliptic/browserify-sign code (verified; the only "secp256k1" strings
    are buildooor's own Plutus builtins). Recorded in `docs/SECURITY.md`; supersedes T7.1's blanket
    "0 prod vulns" as "0 vulns in shipped code". `TrezorConnect.init` manifest contact is
    max@maxalexweber.de / the repo URL — adjust if another contact should own Trezor notices.
  - files (as built): `background/hw/trezor.ts` (SDK boundary, SW), `content/trezorConnect.ts` +
    `manifest.config.ts` (popup relay), `core/hw/ledgerTx.ts` (witness matching + addressBech32),
    `background/walletHandlers.ts` (`hwTrezorPair`/`hwTrezorSign`, shared `finishHwSubmit`),
    `background/hw/accounts.ts` (kind union), `shared/internal.ts`, `shared/walletClient.ts`,
    `options/Ledger.tsx` (unified Hardware manager), `src/types/trezor-connect-webextension.d.ts`
  - tests: ✅ `test/hw.test.ts` +4 (pubkey-matched witness accept, foreign-key reject,
    no-identifier reject, cross-tx replay reject). 362 tests; typecheck + lint + build clean.
  - **remaining (needs the physical device):** pair a real Trezor on preview, send, confirm on-chain
    (done-when). Watchpoints: SW lifetime across a slow popup interaction (Trezor's SDK manages
    keepalive — verify), and old firmware vs `tagCborSets`/MAP_BABBAGE expectations.
- [x] **T6.5 — CIP-103 bulk signing (COMPLETE).** `api.cip103.{signTxs,submitTxs}`, negotiated via `enable({extensions:[{cip:103}]})`. Landed as a pure add-on through the T6.1 generic dispatch — no change to the inpage provider or the message bridge, only a registry entry + background handlers. (Supersedes the §14 defer decision; recorded there.)
  - files: `src/shared/extensions.ts` (registry entry), `src/background/cip30/handlers.ts` (`signTxs`/`submitTxs`, `parseBulkSignRequest`, shared `signingKeysFor`/`submitErrorFor`), `src/background/dapp/approvals.ts` (`signTxs` approval type), `src/shared/internal.ts` (`BulkTxItem`/`BulkSignApprovalPayload`), `src/popup/Connect.tsx` (`SignTxsBody`/`BulkTxCard`), `test-dapp/` (chained + same-input demos)
  - **No batch blind-signing (§1.5):** ONE approval, but every tx in it is decoded with the same `summarizeTx` used by single signTx, in the same two-phase (spinner → payload) flow. The prompt states that approving signs all of them, and sums the fees.
  - **Batch shapes all supported:** independent, **chained** (tx[j] spends an output of tx[i<j] — resolved from the batch itself, so the approval shows real addresses/values instead of "unresolved input"), and **same-input/competing** txs (two entries spending one UTxO — legal, each gets its own witness; the prompt discloses that only one can settle). Per-item `dependsOn` / `conflictsWith` drive those labels.
  - **Witness isolation:** one union of resolved UTxOs is used for the whole batch, so `signingKeysFor` now filters to *that* tx's own input/collateral refs — a sibling tx's wallet-owned input must never contribute a witness (pinned by a test). Conway stake/DRep curation is unchanged and shared with signTx.
  - **Spec conformance:** input order preserved; witness sets index-aligned 1:1; any sign failure throws `TxSignError` naming `tx[i]` and returns **no** witnesses; `submitTxs` attempts every tx even after a failure and returns a mixed `hash32 | {code,info}` array, index-aligned, with the same generic (never raw-provider) error text as `submitTx`.
  - **Wallet-side control (not in the CIP):** `MAX_BULK_TXS = 20` for both methods — an unbounded batch means unbounded chain lookups and a prompt no human can review, i.e. blind-signing by volume. Over the cap → `APIError.InvalidRequest`.
  - **Shared collateral is not a conflict:** conflict detection looks at *spending* inputs only — a Plutus batch routinely declares one collateral UTxO in every tx and all of them can settle (collateral is consumed only on phase-2 failure). Pinned by a test.
  - tests: `test/cip30.test.ts` +14 (gating, independent/chained/same-input batches, shared collateral, witness isolation, one payload-pending prompt, decline, indexed ProofGeneration, malformed input, cap, submit order/mixed results/unlock), `test/extensions.test.ts` +3. 414 tests (410 passing, 4 skipped); typecheck + lint + build clean.
  - **✅ verified in the browser (preview, 2026-07-23):** chained batch — ONE approval showing both txs, both submitted in order through `cip103.submitTxs`; same-input batch — two witness sets, no submit; **decline** — `signTxs` rejects with `user declined bulk signing` and the dApp receives NO witness set at all, not even for the transaction the wallet could have signed (CIP-103 all-or-nothing). The batch approval UI itself was reviewed in the same session and renders as designed. The chained case proves the batch-local resolution end-to-end: tx#2 was built against ref `e8ef5cc2882d…#0` before anything was submitted, and the node returned tx#1 as `e8ef5cc2882d7bd7…` — same id, so the wallet resolved a UTxO that did not yet exist on-chain (without it the approval would have read "input could not be resolved" for exactly the transaction the extension exists to enable).
  - **Test-harness bugs found by that run (fixed in `test-dapp/main.ts`):** tx#1 paid *itself*, so payment and change sat on one address and "first output at my address" grabbed the 2 ₳ payment — below `selectInputs`' `amount + 2 ₳ + 0.1 ₳/input` bar → a bare `insufficient funds`. Now: tx#1 pays 5 ₳ to itself, the chain output is picked by an explicit minimum, balance is checked up front, build errors name `tx#1`/`tx#2`, the same-input demo uses the largest UTxO, and submitted hashes are logged in full with explorer links. Harness-only — no wallet code involved.

---

## M7 — Hardening & Store Release

- [x] **T7.1 — Dependency sandboxing & supply-chain.** Install scripts blocked by default (`.npmrc ignore-scripts=true` + `@lavamoat/allow-scripts`, only esbuild allow-listed); deps exact-pinned; lockfile committed; 0 prod vulns. No publish tokens (not published).
  - **Gate redefinition (2026-07-17, T6.4, human-approved):** the audit target is now **0
    vulnerabilities in SHIPPED code**. `npm audit --omit=dev` reports the unfixable `elliptic`
    advisory inside `@trezor/connect`'s popup-side tree, which never enters `dist/` (build-time
    verified — see T6.4 + `docs/SECURITY.md`). All other prod findings remain 0. Dev-toolchain
    advisories (vitest/vite/esbuild, published 2026-07) are tracked separately — toolchain bump is
    an open follow-up.
  - **Toolchain bump DONE (2026-07-17):** vite 5.4.21 → 8.1.5 (rolldown-based; build + chunk-naming
    guard verified, no leading-underscore chunks), vitest 2.1.9 → 4.1.10 (`testTimeout: 30s` — the
    pure-JS BIP32 derivation tests take 5–10s and vitest 4 enforces the 5s default strictly),
    @vitejs/plugin-react 6.0.3, @crxjs/vite-plugin 2.7.1. All vite/vitest/esbuild dev advisories
    cleared; the remaining audit findings are exclusively the documented Trezor-tree deviation
    (now including a protobufjs critical — popup-side only, dist-verified absent, SECURITY.md).
- [x] **T7.2 — Security review.** Threat-model pass recorded in `docs/SECURITY.md`: §1 invariants verified, blind-sign warning, CSPRNG, `frame-ancestors 'none'`, clipboard caution, `textContent`-only rendering.
- [x] **T7.3 — Test suite.** Unit ✅ 37 files / 362 tests (vitest 4); integration ✅ preview proof
  scripts (`scripts/`); **e2e ✅ Playwright (2026-07-17)** — `npm run e2e` builds dist/ and drives
  the REAL extension in Chromium (`e2e/`, persistent context + `--load-extension`, fresh profile per
  test). 6 specs, network-free by design: (1) restore → lock → wrong-password → unlock lifecycle;
  (2) **vault-at-rest invariants** — chrome.storage.local contains neither mnemonic nor password,
  and `localStorage` is empty (§1.1/§1.2 checked against the actual profile); (3) onboarding
  create-flow gates on the backup ack + word confirmation; (4) CIP-30 provider injected with the
  right identity on a (route-fulfilled) dApp origin; (5) first `enable()` opens the approval popup
  showing the REAL origin (§1.6), approve → working API (getNetworkId 0), grant persists, second
  enable prompts nothing; (6) reject → `APIError Refused (-3)`, nothing granted. Notes:
  `wallet.create` leaves the vault unlocked (session key cached) — the fixtures model that.
  **Mock-provider tier ✅ (same day):** `e2e/mockKoios.ts` — SW fetches aren't Playwright-routable,
  so the Koios provider is pointed at a local HTTP mock (permissive CORS; localhost needs no host
  permission; settings injected via the internal `updateSettings` command). Adds (7) the full §1.5
  send path with the SUBMITTED CBOR decoded in Node and held against what was approved (recipient/
  amount/input + the vkey witness Ed25519-verified against the wallet key over the body hash) and
  (8) dApp `signData` per-call approval (§1.4) with the COSE_Sign1 verified against the wallet key.
  8/8 specs green (~50 s). Still manual: dApp signTx e2e (needs a dApp-built tx; unit-covered),
  hardware devices, `docs/VERIFY.md` visuals. See `docs/TESTING.md`.
- [~] **T7.4 — Firefox port.** **Planned, not shipped — needs a Firefox build target + runtime.** Compat audit done; two blockers (event-page background, `browser.*` namespace) documented in `docs/FIREFOX.md`.
- [~] **T7.5 — Store listing.** Icons ✅; notes + permission justifications + privacy policy in `docs/STORE.md` / `docs/PRIVACY.md`. Screenshots + submission deferred (not a near-term task).

---

## M8 — Backlog / post-v1 enhancements

- [x] **T8.1 — ADA Handle resolution ($handle → address).** ✅ Shipped. The Send recipient field accepts an **ADA Handle** (`$boris`) and resolves it to the current on-chain holder, instead of only a bech32/hex address. Modeled on [`cardano-foundation/cf-adahandle-resolver`](https://github.com/cardano-foundation/cf-adahandle-resolver) — but we **do NOT embed** that service (it's a Java 21 / Spring + Yaci-Store indexer with its own H2 index; wrong shape for an MV3 extension). We reuse its *resolution model* over our existing `IChainProvider`. (252 tests; typecheck + lint + build clean.)
  - **How it resolves.** A handle is an NFT under the official ADA Handle policy `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a`. **This policy id is network-independent — the SAME id on mainnet, preprod, and preview** (a Cardano policy id is the hash of the minting script, which Koralabs deploys identically on every network; confirmed 2026-06-26 — preview/testnet docs and explorers reference the same `f0ff48…`). So **one constant, no per-network policy table.** Caveat for the implementer: the *set of minted handles* differs per network (separate registries) — a mainnet handle won't exist on preprod — but that's handled naturally because we query the active network's provider. The one policy covers both name eras: legacy **CIP-25** = raw hex of the UTF-8 name (`boris`→`626f726973`); newer **CIP-68 (222)** = label prefix `000de140` + hex name (the (100) reference token is ignored — Koralabs kept the same policy id and only switched asset-name encoding for new mints). Resolution = "which address currently holds this NFT (qty 1)". (SubHandles / virtual subhandles resolve differently — datum-based via the reference token — and are out of scope for T8.1.)
  - **Files / shape (as built).** (a) `src/core/cip67.ts` — added the **encode** direction (`encodeCip67(label, contentHex)`, reuses existing `crc8`; round-trips with `parseCip67`). (b) `src/core/handle.ts` (framework-free, unit-tested): `HANDLE_POLICY_ID` constant (all networks), `looksLikeHandle`, `normalizeHandle`, `handleToUnits(name)` → `{cip68, legacy}` (no `network` arg — policy is network-independent), `resolveHandle(input, lookup)` → `{handle, address}` or `HandleError`. The on-chain capability is injected as a minimal structural `AssetAddressLookup` so `core/` stays decoupled from `background/provider`. (c) `IChainProvider.getAssetAddresses?(unit)` — implemented on Blockfrost (`GET /assets/{asset}/addresses`) and Koios (`POST /asset_addresses`); Ogmios omits it (no asset index) → the handler reports it unsupported with a "switch to Blockfrost/Koios" message. (d) message wiring: `resolveHandle` internal command + `wallet.resolveHandle` client + `resolveHandleCmd` handler. (e) `src/popup/Send.tsx` — detects `$handle`, debounced (400 ms) resolve, renders the resolved address inline for the user to verify. (f) **dApp path:** `api.experimental.resolveHandle(handle)` — wire method `resolveHandle` (`shared/messages.ts`), inpage `experimental` namespace, background `resolveHandleForDapp` (origin-gated, no unlock/consent, read-only; returns CIP-30 **hex** address bytes; `HandleError` → APIError -1, no asset index → -2).
  - **Security (this picks the address funds go to — CLAUDE.md §1.5/§1.6).**
    - **Policy = identity.** Only accept the asset under the official `HANDLE_POLICY_ID`. Same name under another policy is NOT a handle (anti-spoof). Cross-references the buildooor policy-hashing note in CLAUDE.md.
    - **Single holder**, else reject: 0 (after dropping 0-qty/empty rows) → unminted/not-found; >1 → ambiguous/suspect (don't pick). CIP-68 (222) tried first, then legacy. ✅
    - **Show the resolved address** in the Send form, and keep the approval screen's real output address as the source of truth (decode-before-sign). The handle is input convenience only — never silently send to a resolved address. ✅
    - **Validate before encoding:** charset `[a-z0-9._-]`, lowercase, root handle ≤ 15 bytes UTF-8, strip leading `$`; reject otherwise (trust-no-input) — the test asserts no lookup is attempted for a malformed handle. ✅
    - **WYSIWYG over re-resolve (decision).** The popup resolves and passes the **concrete bech32 address the user saw** to `buildSend` — we deliberately do NOT re-resolve at build time. Re-resolving could send to a *different* address than the one shown without re-confirmation; passing the literal resolved address makes "what you approved" == "where funds go" (no TOCTOU). The approval screen re-renders that same address as the final check. No persistent cache — each settled keystroke resolves fresh (handles are transferable). SW fetch budget < 30 s (§6). ✅
    - **No new deps / no WASM** (§9): pure-JS, reuses `crc8`/cip67. ✅
  - **Optional (later, behind a flag):** an external `cf-adahandle-resolver` REST endpoint (`GET /api/v1/addresses/by-ada-handle/{handle}`) as an alternative `IHandleResolver` backend. Treat as a **trust boundary** (a compromised resolver redirects funds) — default stays provider-based on-chain resolution; if enabled, still cross-check the on-chain holder. Document in `docs/SECURITY.md`.
  - **done-when:** typing `$<handle>` in Send resolves to the correct current holder on preview/preprod, the resolved address is shown for confirmation, an unminted/forged/ambiguous handle is rejected with a clear message, and `test/handle.test.ts` covers encode (both forms), validation, and the single-holder/policy-guard rules. ✅ Plus `api.experimental.resolveHandle` for dApps, covered by `test/cip30.test.ts` (resolves to hex, no-unlock, invalid→-1, unminted→-1, origin-gated→-3). ✅ **Verified live on preprod** (keyless Koios) via `test/handle.integration.test.ts` — gated by `RUN_INTEGRATION=1`, skipped in default `npm test`; resolves a real root handle to its single holder (cross-checked against `asset_addresses`) and rejects no-holder / never-minted handles.

---

## M9 — CIP-113 Programmable Tokens (DRAFT — assessed 2026-07-17, not scheduled)

Goal: discover, display, and eventually transfer CIP-113 programmable tokens (regulated assets /
stablecoins with on-chain transfer logic — [CIP-0113 PR #444](https://github.com/cardano-foundation/CIPs/pull/444),
[CF reference impl + integration guides](https://github.com/cardano-foundation/cip113-programmable-tokens)).

**⚠️ Gate on upstream maturity.** The Cardano Foundation reference implementation is explicitly
R&D-grade: *unaudited, not production-ready*; the on-chain contracts (and therefore the
`programmable_logic_base` script hash and registry policy — the protocol constants everything below
keys on) may still change. **Build read-only first (T9.1–T9.3); do NOT start transfer support (T9.4–T9.5)
until a stable, audited deployment with published per-network constants exists.** Re-verify constants
against the upstream repo at implementation time.

**Why we're incompatible today (assessment 2026-07-17):** CIP-113 tokens do NOT sit at the user's
base addresses. All holders share ONE script payment credential (the "programmable logic base");
ownership is the **stake-credential slot**: `addr(programmable_logic_base, owner_credential)`.
Our discovery (`src/background/discovery.ts`) walks only own payment-key base addresses, so these
tokens are invisible; `buildSend()` (`src/core/tx/build.ts`) can't produce the required script-spend
+ withdraw-zero transaction. The Plutus machinery to fix that already exists but is dormant/test-only
(`src/core/tx/plutusBuild.ts`, T5.3/T5.4) — this milestone is mostly wiring, not new crypto.

- [x] **T9.1 — Protocol constants + registry client (read-only, framework-free). ✅ (2026-07-17)**
  Registry = on-chain **sorted linked list** of RegistryNode UTxOs: `findRegistryNode(policyId)` /
  `isProgrammablePolicy(policyId)` scan the registry address and return the node's
  `{transferLogicScript, thirdPartyTransferLogicScript, …}` credentials + the node's CURRENT utxoRef.
  - files (as built): `src/core/cip113/params.ts` (constants — instead of the planned
    `shared/constants.ts`, keeping cip113 self-contained in core), `src/core/cip113/registry.ts`,
    `src/core/cip113/address.ts`. All pure; the chain read is injected as a structural
    `RegistryLookup` (same decoupling as `core/handle.ts`).
  - **Constants:** `BUILTIN_CIP113_PARAMS` ships EMPTY (no audited deployment exists); per-network
    params come from the validated settings override `WalletSettings.cip113Params`
    (`{programmableLogicBase, registryAddress, registryNodePolicyId}`) — a developer/experiment knob,
    no Settings UI. Validation rejects bad hex and cross-network registry addresses (trust-no-input).
  - **NFT = authenticity (anti-spoof):** the registry address is public, so a node only counts if its
    UTxO holds a token under `registryNodePolicyId` whose asset name equals the datum `key` (upstream
    invariant). A forged datum without the NFT is ignored — unit-tested.
  - **Never cached:** node utxoRefs resolve fresh per call (upstream pitfall recorded in the module
    header); datum decoder is tolerant (foreign shapes → null, never a throw on chain data).
  - **Enabler:** providers fetched inline datums but dropped them — `toUtxo` (provider `mappers.ts`)
    now maps `inline_datum`/`data_hash` → `resolved.datum` (Blockfrost getUtxos+resolveUtxos, Koios
    `_extended` rows; unparseable datum → dropped, not fatal). Ogmios/Kupo still datum-less (Kupo
    needs a separate `/datums/{hash}` fetch — deferred until a CIP-113 flow needs that stack).
  - done-when: ✅ `test/cip113.test.ts` (20 cases: params validation, address header/round-trip,
    7-field + minimal + origin-node decode, malformed-shape nulls, NFT-auth lookup incl. forged/
    mismatched/wrong-policy spoofs, datum mapping). 344 tests; typecheck + lint + build clean.
    **remaining (blocked upstream):** live preview lookup behind `RUN_INTEGRATION=1` — impossible
    until a public reference deployment publishes constants.
- [x] **T9.2 — Discovery: see programmable-token balances. ✅ (2026-07-17)**
  `overview()` (`walletHandlers.ts`) now computes `addr(programmable_logic_base, ownerCred)` for BOTH
  owner conventions — stake key hash (preferred) and payment key `0/0` hash (enterprise variant per
  the integration guide) — via `ownProgrammableAddresses()`, queries them with the existing
  `collectUtxos`, and returns the aggregate as `WalletOverview.programmable` (a SEPARATE
  `WalletBalance`, never merged into `balance`). Skipped when no params are configured for the active
  network; lookup failures are non-fatal (warn + omit — an experimental feature must never break the
  main balance view).
  - **CIP-30 semantics decision (RECORDED):** programmable-token UTxOs are **excluded from dApp-facing
    `getBalance`/`getUtxos`/`getCollateral`** and shown only in the popup dashboard. Rationale: they
    are NOT vkey-spendable; returning them would poison every dApp's coin selection, and
    `getCollateral` must stay ADA-only/key-spendable. The exclusion is **structural**: the cip30
    handlers and `buildSend` derive their address set exclusively from the wallet's own base addresses
    (`collectUtxos` over discovery output) — programmable addresses exist only inside `overview()`'s
    display path, so there is no code path by which these UTxOs can reach the dApp surface or coin
    selection. Revisit only if/when a CIP standardizes exposure.
  - done-when: address computation + both-conventions dedup unit-tested (`test/cip113.test.ts`);
    live preview balance check blocked on an upstream deployment (see T9.1 remaining).
- [x] **T9.3 — Display: mark programmable tokens. ✅ (2026-07-17)**
  Dashboard renders a separate "Programmable tokens" card (CIP-113 badge per asset, reuses the lazy
  CIP-25/68 name resolution + `AssetDetail` overlay) with an explicit "transfers follow the issuer's
  on-chain rules and aren't supported from this wallet yet" note. All chain strings render as React
  text nodes only (§1.8).
  - files (as built): `src/popup/Dashboard.tsx`, `src/shared/internal.ts` (`WalletOverview.programmable`)
  - **Send refusal:** satisfied structurally today — the Send flow is ADA-only (`buildSend` takes
    lovelace, no asset picker) and funds exclusively from base-address UTxOs, so a programmable token
    cannot be selected or spent from Send at all. When Send grows an asset picker, it must source
    assets from `balance` (never `programmable`) and keep an explicit policy-guard — re-open this task
    then.
  - done-when: ✅ badge + section render for a populated `programmable` bundle; plain send untouched.
- [~] **T9.4 — Transfer builder — IMPLEMENTED (2026-07-17), on-chain verification pending.**
  **GATE LIFTED by explicit human decision (2026-07-17): "experimental anyway" — testnet-only.**
  Mainnet remains impossible regardless (no deployment constants exist).
  - files (as built): `src/core/cip113/transfer.ts` (`buildProgrammableTransfer`), `params.ts`
    (`Cip113TransferParams` — validated config block), `registry.ts` (node ref now carries the UTxO).
  - **Shape per the upstream guide:** script-spend of the sender's programmable UTxOs (base
    validator), output at `addr(base, recipientStakeCred)` + token change back to the SENDER's
    programmable address (never a regular address), BOTH reference inputs (registry node FRESH +
    protocol params), BOTH withdraw-zero invocations, `TransferAct{TokenExists{node_idx}}` on the
    global, `requiredSigners = [stake key hash]` (ownership inverts the payment-key model — the
    existing generic signer derives role-2 keys unchanged), ADA-only collateral.
  - **Scripts come INLINE from config** (`transfer.scripts` CBOR hex — upstream doesn't document
    where reference scripts live) and are HASH-VERIFIED against their credentials; the transfer-logic
    script must match the LIVE registry node's credential. Postconditions on the built tx (node_idx
    position, both zero-withdrawals, tokens only at programmable addresses) throw before anything is
    signable.
  - **Upstream-undocumented assumptions (recorded in the module header — re-verify against a real
    deployment):** TransferAct=constr 0 / TokenExists=constr 0; base-spend + transfer-logic
    redeemers = unit constr 0 (validators documented/expected to ignore them); recipient datum =
    preserved source datum.
  - **Found + patched buildooor dual-class bug #4:** `TxBody` validated withdrawals against
    `dist/ledger/TxWithdrawals` (instanceof the WRONG `StakeAddress` copy) — StakeAddress-keyed
    withdrawals were rejected outright, and the bare-hash fallback silently defaults reward accounts
    to MAINNET. Same single-line repoint as the three existing patch fixes
    (`patches/@harmoniclabs+cardano-ledger-ts+0.5.1.patch`, now 4 fixes); the unit test asserts the
    TESTNET network byte survives a CBOR round-trip.
  - tests: ✅ `test/cip113Transfer.test.ts` (13) — self-consistent fixture validator world (three
    distinct always-succeeds V3 scripts): outputs/change routing, ref-input index, withdraw-zero ×2
    on testnet, stake-key requiredSigner, TransferAct redeemer CBOR, script-data-hash + round-trip,
    and six refusal paths (wrong-hash script, registry mismatch, insufficient, enterprise recipient,
    foreign node, missing config). 375 tests; typecheck + lint + build clean.
  - **ON-CHAIN VERIFIED (2026-07-17) via a SELF-DEPLOYED world on preview.** `scripts/cip113-deploy.cjs`
    stands up a CIP-113-shaped deployment (always-succeeds V3 scripts for base/global/transfer-logic,
    the two script stake creds REGISTERED, a real registry-node UTxO with NFT+datum, a params UTxO,
    and 1000 TEST113 minted to the wallet's programmable address) and prints the `cip113Params` to
    paste into the wallet. `scripts/cip113-transfer.cjs` then mirrors `transfer.ts` and submits a real
    transfer — **confirmed on preview (tx `9d13443c…`): 100 TEST113 moved from the sender's
    programmable address to a different owner's, sender 1000→900, recipient 0→100.** This proves the
    ledger accepts the whole transfer SHAPE: script-spend of the programmable UTxO, BOTH withdraw-zero
    invocations against registered script stake creds, registry+params reference inputs, TransferAct
    redeemer, collateral, phase-2 execution, submit + confirm. (Both scripts live under the gitignored
    `scripts/`; the deploy needed the `TxBody`/`StakeAddress` withdrawals patch and manual
    certificate-deposit accounting, both noted in the script.)
  - **still open (needs the REAL CF contracts, not our stand-in):** the always-succeeds validators
    accept anything, so the upstream-undocumented redeemer/datum encodings are NOT validated by this
    proof — re-verify against an audited deployment before real value. Unregistered-stake-address
    ledger rejection is now understood (the deploy registers the creds precisely to avoid it).
- [~] **T9.5 — Send flow + approval decode — IMPLEMENTED (2026-07-17), same pending verification.**
  Dashboard programmable rows now carry a Send button (replacing T9.3's refusal note) → dedicated
  `ProgrammableSend` overlay (`popup/Dashboard.tsx`): recipient BASE address + quantity → decoded
  review stating explicitly where tokens land (the recipient's programmable address, shown in full),
  that the issuer's transfer rules run via two validator invocations, and the fee — never an opaque
  blob (§1.5). Approve reuses the id-bound pending/approve machinery (`approveSend`), so the signed
  tx is exactly the one summarized; the stake-key witness derives through the existing generic
  signer path. Background: `buildProgrammableSend` (`walletHandlers.ts`) — registry resolved fresh,
  v1 spends only single-asset programmable UTxOs (a mixed UTxO can't leak other tokens to regular
  change).
  - **not yet:** dApp-built CIP-113 txs via `signTx` get no special decode (they render as a generic
    Plutus tx with withdrawals — safe but not narrated); `summary.ts` CIP-113 narration is a
    follow-up with the on-chain verification.

**Milestone exit:** programmable tokens are visible and safely transferable with informed approval —
or, pre-audit, visible with plain-send correctly blocked (T9.1–T9.3 alone is a valid stopping point).

