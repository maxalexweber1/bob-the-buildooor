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

## M0 — Scaffold & Message Bridge

Goal: an installable empty extension whose four contexts talk end-to-end.

- [ ] **T0.1 — Project init.** `npm create vite@latest` (React+TS), add `@crxjs/vite-plugin`, `vitest`, ESLint/Prettier, `typescript`.
  - files: `package.json`, `vite.config.ts`, `tsconfig.json`, `.eslintrc`, `manifest.config.ts`
  - done-when: `npm run dev` loads an unpacked extension in Chrome with a blank popup.
- [ ] **T0.2 — MV3 manifest.** Encode the manifest from IMPLEMENTATION_PLAN §4 (background module SW, content script `document_start`, `web_accessible_resources: inpage.js`, CSP `script-src 'self'`, perms `storage/unlimitedStorage/idle/alarms`).
  - files: `manifest.config.ts`
  - done-when: extension loads with **zero** CSP/manifest warnings.
- [ ] **T0.3 — Shared message protocol.** Define typed request/response envelopes and method enums.
  - files: `src/shared/messages.ts` (`{ id, target, method, params, origin }`, `RpcResult<T>`), `src/shared/methods.ts`
  - done-when: types compile; one source of truth imported by all contexts.
- [ ] **T0.4 — inpage provider stub.** Inject `window.cardano.bob = { apiVersion, name, icon, isEnabled, enable }`; implement the `postMessage` request helper with `id` correlation + `source`/`target`/`origin` filters (IMPLEMENTATION_PLAN §4 rule 2).
  - files: `src/inpage/provider.ts`, `src/inpage/rpc.ts`
  - done-when: `window.cardano.bob.enable()` in a page console round-trips a stub response.
- [ ] **T0.5 — content relay.** Inject `inpage.js` via script tag; relay `window.postMessage` ↔ `chrome.runtime` port; forward `e.origin`.
  - files: `src/content/content.ts`
  - done-when: messages reach the SW and responses return; verified in both Chrome and a second profile.
- [ ] **T0.6 — background router + keepalive.** Port listener (`chrome.runtime.connect`), method dispatch table, long-lived port kept open during pending requests.
  - files: `src/background/index.ts`, `src/background/router.ts`
  - done-when: an artificial 60 s pending request resolves without SW death dropping it.

**Milestone exit:** echo test inpage→content→background→popup and back, with origin captured, passes in CI.

---

## M1 — Keyring & Vault (security core)

Goal: create/restore a wallet, encrypt it, lock/unlock survives SW restarts.

- [x] **T1.1 — Decide KDF** (IMPLEMENTATION_PLAN §14). Pick **PBKDF2 ≥600k via SubtleCrypto** (keeps `script-src 'self'`) *or* Argon2id (accept `'wasm-unsafe-eval'`). Record decision in this file.
  - **DECISION (2026-06-23): PBKDF2-HMAC-SHA256, ≥600,000 iterations, via `crypto.subtle`.** Keeps the strict CSP `script-src 'self'` — **no** `'wasm-unsafe-eval'`, no WASM KDF dependency (honours CLAUDE.md §1.7/§1.9). AES-256-GCM for the cipher. KDF id + iteration count + salt persisted in vault metadata so the parameters can be migrated forward (e.g. raise iterations) without locking out existing vaults.
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
- [ ] **T6.2 — Conway certs/voting in signTx.** Witness vote-delegation, DRep reg/retire, voting/proposal procedures.
  - files: `src/background/cip30/signTx.ts`, `src/core/tx/build.ts`
  - done-when: a vote/delegation tx confirms on testnet.
- [ ] **T6.3 — Ledger (WebHID).** `ledgerjs-hw-app-cardano` + `hw-transport-webhid`; derive + sign; `tx.addVKeyWitness(...)`. **Transport outside the SW** (page/offscreen).
  - files: `src/background/hw/ledger.ts`, offscreen doc
  - done-when: a Ledger-signed tx confirms; keys never in the browser.
- [ ] **T6.4 — Trezor (Connect, popup mode).** Account import + signing; document the iframe-in-extension workaround.
  - files: `src/background/hw/trezor.ts`
  - done-when: a Trezor-signed tx confirms.

---

## M7 — Hardening & Store Release

- [x] **T7.1 — Dependency sandboxing & supply-chain.** Install scripts blocked by default (`.npmrc ignore-scripts=true` + `@lavamoat/allow-scripts`, only esbuild allow-listed); deps exact-pinned; lockfile committed; 0 prod vulns. No publish tokens (not published).
- [x] **T7.2 — Security review.** Threat-model pass recorded in `docs/SECURITY.md`: §1 invariants verified, blind-sign warning, CSPRNG, `frame-ancestors 'none'`, clipboard caution, `textContent`-only rendering.
- [~] **T7.3 — Test suite.** Unit ✅ 20 files / 145 tests; integration ✅ preview proof scripts (`scripts/`); **e2e (Playwright) pending — needs a real browser, human-run.** See `docs/TESTING.md`.
- [~] **T7.4 — Firefox port.** **Planned, not shipped — needs a Firefox build target + runtime.** Compat audit done; two blockers (event-page background, `browser.*` namespace) documented in `docs/FIREFOX.md`.
- [~] **T7.5 — Store listing.** Icons ✅; listing copy, permission justifications & privacy policy ✅ (`docs/STORE.md`, `docs/PRIVACY.md`). **Screenshots + CWS/AMO submission pending — needs store accounts + a running build (human).**

---

## Critical Path & Parallelism

```
M0 ──► M1 ──► M2 ──► M3 ──► M4 ──► M5 ──► M6 ──► M7
              │            │
              └─ provider  └─ (T4.5 signData can start once M1 keys exist)
```
- **Hard gate:** M1 (keys) blocks all signing. M0 (bridge) blocks all CIP-30.
- **Parallelizable:** provider impls (T2.2/T2.3) alongside dashboard (T2.5); COSE (T4.5) alongside signTx (T4.3); HW wallets (M6) independent of Plutus (M5) once M4 is done.

## Definition of Done (project)

- A user can create/restore a wallet, see balances, send ADA+tokens, and use a real CIP-30 dApp on **mainnet**, including a Plutus interaction, with every signature gated by a human-readable approval — keys encrypted at rest and never leaving the device (or HW).

## Testing Strategy (quick reference)

- **Unit:** crypto round-trips, BIP39/CIP-1852 vectors, CBOR decode/encode, COSE sign↔verify.
- **Contract:** CIP-30 method shapes + error codes against the spec.
- **Integration:** preview/preprod testnet send, dApp connect, Plutus spend/mint.
- **Manual security:** SW-kill unlock survival, auto-lock, origin allowlist, blind-sign decode.
