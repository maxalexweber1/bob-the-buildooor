# CLAUDE.md — Agent Operating Rules for bob-the-buildooor

This file governs how AI agents work in this repo. It is **strict**. When a rule here conflicts
with a default behavior or a general best practice, **this file wins**. If you cannot follow a rule,
stop and ask — do not work around it.

---

## 0. What this project is

A standalone Cardano **self-custody browser-extension wallet** (Manifest V3, CIP-30) built on
`@harmoniclabs/buildooor`. Self-custody means **this code handles users' private keys and seed
phrases**. A bug here can drain real funds. Treat every change as security-sensitive.

- **The plans are the contract.** Read before changing anything:
  - `docs/IMPLEMENTATION_PLAN.md` — architecture & decisions (the *what*).
  - `docs/EXECUTION_PLAN.md` — ordered, task-by-task build guide (the *how*). Work tasks in order; cite the task id (e.g. `T1.4`) in your summaries.
- Do not introduce architecture that contradicts the plans without updating the plan in the same change and flagging it.

---

## 1. Security non-negotiables (NEVER break these)

These are hard invariants. Violating any one is a critical defect, even if tests pass.

1. **No secrets in globals.** Never store a decrypted seed, root key, derived private key, or password
   in a service-worker module-level variable or any persistent store in plaintext. Decrypted key
   material lives **only** in transient function scope or, when caching is required, as the derived
   AES key in `chrome.storage.session` (never the password, never the seed). See IMPLEMENTATION_PLAN §5.
2. **Never `localStorage`.** The encrypted vault goes in `chrome.storage.local` (or IndexedDB). Never
   `window.localStorage` (unavailable in the SW, synchronous, trivially readable).
3. **Never log secrets.** No `console.log`/telemetry/error message may contain a seed, private key,
   password, derived key, or full mnemonic. Redact. This includes thrown error messages.
4. **Per-call consent.** Every `signTx` / `signData` / first `enable` MUST be gated by an explicit
   user approval in the trusted popup. A content script or dApp must never obtain a signature without it.
   Signing happens only in the privileged background/popup context, never in inpage/content.
5. **Decode before sign.** Approval UIs must render a human-readable transaction summary
   (inputs/outputs/amounts/fee/mint/metadata/certs). Never ask the user to approve an opaque CBOR blob.
6. **Trust no page input.** In inpage↔content messaging, always enforce `e.source === window`, the
   namespaced `target`, `id` correlation, and forward the **real** `e.origin` from the content script
   (never accept an origin claimed by the page). Enforce the origin allowlist in the background.
7. **Strict CSP stays strict.** Keep `script-src 'self'`. Do **not** add `'wasm-unsafe-eval'` or any
   remote/inline script source without an explicit decision recorded in EXECUTION_PLAN T1.1 and human approval.
8. **No untrusted HTML.** In the popup, render dApp/chain strings (token names, titles, metadata) via
   React text nodes / `textContent` only. Never `dangerouslySetInnerHTML` with external data.
9. **Pure-JS crypto only by default.** The dependency on a no-WASM stack is a security feature
   (it is what lets the CSP stay tight). Do not introduce a WASM crypto/serialization lib (CSL/CML,
   argon2-wasm, etc.) without the T1.1 decision + human approval.

If a task seems to require breaking one of these, it is mis-specified — stop and ask.

---

## 2. Workflow rules

- **Never commit or push** unless the user explicitly says so in the current request. Stage at most;
  leave committing to the user. Never `git push`, never create remotes, never force-push.
- **Never run network/integration tests against mainnet.** Testnet (preview/preprod) only, and only
  when asked. Default to unit tests.
- **Run `npm run typecheck` and `npm run lint`** after code changes; report results. Do not silence
  errors with `// @ts-ignore`, `any`, `eslint-disable`, or non-null `!` to make them pass — fix the cause.
- **Secrets/keys are never hard-coded.** API keys (Blockfrost, etc.) come from settings/env, never committed.
  `.env` is gitignored — keep it that way; add to `.env.example` instead.
- **Small, reviewable changes.** One task (`Tx.y`) per change where possible. Summaries cite the task id
  and the security invariants touched.
- **Don't add dependencies casually.** New deps on a key-handling project are attack surface (see the
  Ledger Connect-Kit incident). Justify each, prefer audited/pure-JS, pin versions, keep the lockfile.

---

## 3. Tech stack (do not deviate without updating the plan)

- **Language/UI:** TypeScript (strict), React 18.
- **Build:** Vite + `@crxjs/vite-plugin`, Manifest V3.
- **Cardano core:** `@harmoniclabs/buildooor` (re-exports ledger-ts, bip32_ed25519, crypto, cbor,
  plutus-data, plutus-machine). Import wallet symbols from `@harmoniclabs/buildooor`.
- **Mnemonic:** `@scure/bip39` (the one gap buildooor doesn't cover).
- **Chain data:** own `IChainProvider` over Blockfrost / Koios / Ogmios+Kupo (IMPLEMENTATION_PLAN §7).
- **State:** Zustand in the popup; `chrome.storage` is the source of truth (the SW is ephemeral).

Rejected on purpose: CSL/CML (WASM), Lucid/Mesh (WASM under the hood). See IMPLEMENTATION_PLAN §2.

---

## 4. Project structure

```
src/
  inpage/      MAIN-world CIP-30 provider. NO chrome.* here. postMessage only.
  content/     ISOLATED relay. Injects inpage, stamps trusted origin.
  background/  Service worker = wallet core. Keyring, vault, signer, cip30/, provider/, dapp/.
  core/        Framework-free, reusable from SW + popup: address, tx/, cbor/, cose/, crypto/.
  popup/       React UI. Privileged context. Approval/Send/Dashboard/Unlock/Connect.
  options/     Onboarding, settings, backup.
  shared/      Message types, method/error enums, constants.
```
Context boundaries are security boundaries. Code in `inpage/` must never import `background/` internals
or touch `chrome.*`. Signing/key code must never be importable into `inpage/` or `content/`.

---

## 5. Commands

```bash
npm run dev         # load unpacked from dist/ in chrome://extensions (Developer mode)
npm run build       # typecheck + production build
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm run test        # vitest (unit)
npm run format      # prettier
```

Loading in Chrome: `npm run dev`, then chrome://extensions → Developer mode → Load unpacked → `dist/`.

---

## 6. Coding conventions

- TypeScript strict mode is on (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, etc.). Keep it.
- No `any`. Model CIP-30 shapes precisely (hex-CBOR strings are branded/aliased, not bare `string` where it matters).
- All CIP-30 returns are **hex-encoded bytes**; accept **bech32 or hex** for address inputs.
- Implement CIP-30 error codes exactly (IMPLEMENTATION_PLAN §9): `APIError`, `TxSignError`,
  `DataSignError`, `TxSendError`, `PaginateError`. Don't throw bare `Error` across the bridge.
- Keep provider `fetch` timeouts < 30 s (the SW dies on a 30 s fetch).
- Prefer pure functions in `core/` with unit tests over logic embedded in handlers/UI.
- Comments explain *why* (esp. security/CBOR/derivation choices), not *what*.

---

## 7. Testing

- **Unit (default):** crypto round-trips, BIP39/CIP-1852 known vectors, CBOR decode/encode, COSE sign↔verify, CIP-30 shapes/error codes.
- **Integration:** testnet only, only when asked.
- A change that touches key handling, signing, or the message bridge MUST add/extend unit tests.
- Never weaken a test to make it pass; never delete a failing security test without explaining why.

---

## 8. When unsure

Ask. Especially before: changing the CSP, adding a dependency, altering the message-bridge security
filters, changing how/where keys are stored, or anything that would touch §1. A wrong guess here costs
user funds — a question costs a sentence.
