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

- [x] **T6.1 — CIP-95 extension.** Negotiate via `enable({extensions:[{cip:95}]})`; `api.cip95.{getPubDRepKey,getRegisteredPubStakeKeys,getUnregisteredPubStakeKeys,signData}`.
  - files: `src/background/cip30/cip95.ts`
  - key APIs: DRep key `…/3/0` (CIP-105)
  - note: dispatch the `cipNN.` namespace **generically** off `supportedExtensions` (IMPLEMENTATION_PLAN §9), not hard-wired to CIP-95 — so CIP-103/104 drop in without touching the bridge. `getRegisteredPubStakeKeys` stays un-namespaced per spec.
- [x] **T6.2 — Conway certs/voting in signTx (parse + decode + witness; on-chain confirm pending).**
  - **Unblocked via the patch (b68105f approach, cleanly):** the Conway-cert dual-class turned out to be a single-line repoint, same shape as the memo fix — `dist/tx/body/TxBody.js`'s `Certificate` require → `eras/common/ledger/certs/Certificate.js`, so `certificateFromCborObj` (parse) and `isCertificate` (validate) use the same (Conway-aware) copy. Added to `patches/@harmoniclabs+cardano-ledger-ts+0.5.1.patch` (now 3 fixes). **Verified end-to-end:** a real Conway vote-delegation tx now `Tx.fromCbor`-parses and round-trips (`test/tx.test.ts` — would throw unpatched). (My earlier "certType of undefined" was a red herring — buildSync wants `certificates:[{cert}]`, not `[cert]`.)
  - **Wallet-side decode DONE (anti-blind-sign §1.5):** `core/tx/certs.ts` (`certView`/`decodeCerts`/`decodeGovernance`) → human lines ("Delegate voting power to DRep X", "Register as a DRep (deposit 500 ₳)", …) + governance presence (votes flag + proposal count). Wired into `summarizeTx`; rendered in the signTx approval (`CertRows`/`GovernanceRows`); generic cert/gov warning removed. signTx witnessing offers stake+DRep keys via `flags.certificates/governance`.
  - files: `src/core/tx/certs.ts`, `src/core/tx/summary.ts`, `src/popup/Connect.tsx`, `patches/…` ; tests `test/certs.test.ts` (7) + `test/tx.test.ts` Conway end-to-end. 238 tests; typecheck + lint + build clean.
  - **remaining:** a vote/delegation tx **confirms on testnet** (needs a live wallet owning the stake cred — can't run here). Outbound gov-tx *building* (we don't do it; dApps/GovTool do) would deep-import the `ConwayCert*` classes or add b68105f's barrel re-export.
- [ ] **T6.3 — Ledger (WebHID).** `ledgerjs-hw-app-cardano` + `hw-transport-webhid`; derive + sign; `tx.addVKeyWitness(...)`. **Transport outside the SW** (page/offscreen).
  - files: `src/background/hw/ledger.ts`, offscreen doc
  - **HARD MV3 constraint (standards review 2026-06, Chrome docs):** `HID.requestDevice()` *cannot* be called from the service worker and needs a user gesture — call it from the popup/options/offscreen page, then the SW may use `navigator.hid.getDevices()`. So device picking lives in a privileged page; the SW only re-binds to an already-granted device.
  - done-when: a Ledger-signed tx confirms; keys never in the browser.
- [ ] **T6.4 — Trezor (Connect, popup mode).** Account import + signing; document the iframe-in-extension workaround.
  - files: `src/background/hw/trezor.ts`
  - done-when: a Trezor-signed tx confirms.
- [ ] **T6.5 — CIP-103 bulk signing (DEFERRED, should-have).** `api.cip103.{signTxs,submitTxs}` — one approval for a chain of txs. **Deferred post-v1** (IMPLEMENTATION_PLAN §14): adoption unverified; implement as a pure add-on via the generic dispatch (T6.1) when a target DeFi dApp requires it. Approval UI must still decode **every** tx in the batch (CLAUDE.md §1.5) — no batch-blind-sign.

---

## M7 — Hardening & Store Release

- [x] **T7.1 — Dependency sandboxing & supply-chain.** Install scripts blocked by default (`.npmrc ignore-scripts=true` + `@lavamoat/allow-scripts`, only esbuild allow-listed); deps exact-pinned; lockfile committed; 0 prod vulns. No publish tokens (not published).
- [x] **T7.2 — Security review.** Threat-model pass recorded in `docs/SECURITY.md`: §1 invariants verified, blind-sign warning, CSPRNG, `frame-ancestors 'none'`, clipboard caution, `textContent`-only rendering.
- [~] **T7.3 — Test suite.** Unit ✅ 24 files / 168 tests; integration ✅ preview proof scripts (`scripts/`); e2e (Playwright) pending. See `docs/TESTING.md`.
- [~] **T7.4 — Firefox port.** **Planned, not shipped — needs a Firefox build target + runtime.** Compat audit done; two blockers (event-page background, `browser.*` namespace) documented in `docs/FIREFOX.md`.
- [~] **T7.5 — Store listing.** Icons ✅; notes + permission justifications + privacy policy in `docs/STORE.md` / `docs/PRIVACY.md`. Screenshots + submission deferred (not a near-term task).

