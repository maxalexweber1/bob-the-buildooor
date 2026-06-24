# Security Model

bob-the-buildooor is a **self-custody** Cardano wallet (MV3 browser extension). It handles seed phrases
and private keys; a bug can drain funds. This document is the threat model and the security review
record. The binding invariants live in [CLAUDE.md §1](../CLAUDE.md).

## Trust boundaries (= context boundaries)

| Context | Trust | Holds keys? | chrome.* |
|---|---|---|---|
| `inpage/` (MAIN world) | **untrusted** (shares the dApp's JS) | no | no |
| `content/` (ISOLATED) | semi — relays only, stamps the real origin | no | yes (port only) |
| `background/` (service worker) | **trusted** — wallet core | transiently | yes |
| `popup/` + `options/` | **trusted** UI | no | yes |

`inpage`/`content` never import `background`, `core/keys`, `core/crypto`, `signer`, or `vault`
(enforced + verified). Signing happens **only** in the background.

## Key lifecycle

- Seed is encrypted at rest (PBKDF2-HMAC-SHA256 ≥600k → AES-256-GCM, 32-byte salt, 12-byte IV) in
  `chrome.storage.local`. **Only ciphertext is persisted.** Never `localStorage`.
- On unlock, the **derived AES key** (not the password, not the seed) is cached in
  `chrome.storage.session` (in-memory, `TRUSTED_CONTEXTS`, cleared on browser close) so the wallet
  survives service-worker death. Auto-lock (`chrome.alarms` + `chrome.idle`) bounds exposure.
- The mnemonic/root key live only in transient function scope during an operation and are discarded.
- No `console.*` anywhere — secrets can't leak to logs.

## dApp bridge (CIP-30)

- Long-lived port keeps the SW alive during approval.
- The authorizing **origin is Chrome's `port.sender.origin`** — never trusted from the page or a
  (possibly compromised) content script.
- Every gated method requires an allowlisted origin **and** an unlocked wallet.
- **Per-call consent:** `enable`, `signTx`, `signData` each open a trusted popup window. A closed
  window counts as a decline.
- **Decode-before-sign:** `signTx` resolves inputs and renders **all** recipient and own/change
  outputs with their native assets, the fee, **decoded mint/burn** (signed per-asset quantities) and
  **decoded reward withdrawals** (destination + amount). It still **warns** for the components not yet
  decoded in detail (certificates/governance/metadata/required-signers — buildooor lacks Conway-cert
  decoding). Never a blind blob. `signTx` returns only the witness set.
- **Concurrent approvals are isolated:** each prompt is stored under its own `reqId`-scoped key and the
  popup loads exactly the request its window was opened for — a second (possibly malicious) request
  can't overwrite or be answered in place of a legitimate one.
- **Origin hygiene:** only well-formed `https` (or `http://localhost`) origins may drive the bridge;
  the empty/opaque (`''`/`"null"`) origin is refused before it could reach the allowlist. Connected
  sites are listed in Settings and can be **revoked**.

## Structural defenses

- **Strict CSP** `script-src 'self'` — no remote/inline script, no `eval`. The pure-JS (no-WASM)
  stack means **no `wasm-unsafe-eval`**. `frame-ancestors 'none'` hardens against clickjacking.
- Untrusted strings (addresses, token names, metadata, dApp origin) render as React **text nodes**
  only — never `dangerouslySetInnerHTML`.
- All randomness is CSPRNG (`crypto.getRandomValues` / `@noble` via `@scure/bip39`) — no `Math.random`.
- Dependencies are **exact-pinned**, lockfile committed, 0 production vulnerabilities. Install scripts
  are **blocked by default** (`.npmrc ignore-scripts=true` + `@lavamoat/allow-scripts`); only the
  vetted esbuild native-binary build is allow-listed (run `npm run allow-scripts` after `npm ci`).
  This blunts the Ledger-Connect-Kit class of supply-chain attack via malicious `postinstall` scripts.

## Review status (2026-06-24)

All CLAUDE.md §1 invariants were verified against the code. No critical or key-leak findings (byte-exact
review↔sign binding and the no-secrets-in-globals/logs invariants hold). A follow-up adversarial pass
(four subsystem reviewers) found and **fixed**: the concurrent-approval race (per-`reqId` keying);
incomplete decode-before-sign (now renders all outputs + assets, decodes mint/burn and withdrawals);
opaque-origin allowlist gap (origin guard); the Ogmios WebSocket leak + missing connect timeout;
wrong-network send guard; a dApp-revoke UI. Earlier hardening: blind-sign warning, `Math.random` →
CSPRNG, CSP `frame-ancestors`, recipient paste caution. Each fix has unit-test coverage.

### Known limitations / open items
- **Offline brute-force** resistance of the at-rest vault = the KDF strength (PBKDF2 600k). There is
  no unlock attempt-limiting; password strength matters (min 8 enforced).
- **CIP-95 governance signing** is implemented but **unverified** — the pinned buildooor can't build
  or round-trip Conway governance certs (`isCertificate` rejects them). Revisit on buildooor support.
- `getRegisteredPubStakeKeys` doesn't yet query on-chain registration (returns `[]`).
- Hardware-wallet support (Ledger/Trezor) not yet implemented.
- Firefox build not yet shipped (`docs/FIREFOX.md`); e2e/browser tests are human-run (`docs/TESTING.md`).
- Not yet exercised by an external penetration test.

## Reporting

Found an issue? Open a private security advisory on the repository. Do not file a public issue for
anything that could affect funds.
