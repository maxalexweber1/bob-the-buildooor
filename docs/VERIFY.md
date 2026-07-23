# Live Verification Guide

Manual end-to-end checks for the loaded extension on **preview testnet** (real Chrome + service worker
+ chain). Each item maps to a plan `done-when`.

> ⚠️ Preview/preprod **testnet only** (CLAUDE.md §2). Never use a mainnet seed with real funds here.

## 0. Prerequisites

- Node ≥ 20, Chrome (or a Chromium with MV3).
- `.env` has `VITE_BLOCKFROST_PROJECT_ID_PREVIEW=preview…` (already copied from ODATANO; gitignored).
- (Optional, for Plutus/Ogmios) a reachable Ogmios endpoint, e.g. `ws://localhost:1337`.

```bash
npm install
npm run build          # outputs dist/
```

Load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`.
Pin the toolbar icon. (For HMR dev instead: `npm run dev`, then load `dist/`.) After any rebuild,
click the card's **reload ↻** so the new service worker loads; if `host_permissions` changed, Chrome
re-prompts for the provider host access — accept it (else Koios/self-hosted fetches stay CORS-blocked).

Serve the test dApp (separate terminal) — a Vite-bundled page that builds real transactions in-page
with buildooor and drives the wallet's CIP-30 provider (connect/read/signData + build→sign→submit for
send/mint/burn):
```bash
npm run dev:dapp    # → http://localhost:5180
```

---

## 1. M1 — Keyring & Vault

| # | Do | Expect | done-when |
|---|----|--------|-----------|
| 1.1 | Click the toolbar icon on a fresh profile | Popup shows "No wallet yet" → "Create or restore" | T1.7 |
| 1.2 | Options → **Create** → write the 24 words → confirm the 2 requested words → set password (≥8) | "Wallet ready ✓" | T1.7 |
| 1.3 | Reopen popup → enter password | Unlocks → Dashboard | T1.7 |
| 1.4 | `chrome://extensions` → the extension's **service worker** → **terminate**. Reopen popup, click Refresh | Still unlocked, no re-prompt | **T1.6** (SW-death survival) |
| 1.5 | Wait out the auto-lock (default 15 min) or lock the OS screen | Popup re-prompts for password | T1.6 |
| 1.6 | Reinstall → **Restore** with the same 24 words | Same address 0 as before | T1.4 / T1.7 |
| 1.7 | (optional) Import the all-zero seed `abandon ×23 art` into Eternl/Yoroi testnet | addr 0 == `addr_test1qqqt0pru…qqpavzj` | **T1.4 external cross-check** |

## 2. M2 — Read-only wallet

| # | Do | Expect | done-when |
|---|----|--------|-----------|
| 2.1 | Note the Dashboard **receive address**. Fund it from the preview faucet (https://docs.cardano.org/cardano-testnets/tools/faucet) | — | — |
| 2.2 | Refresh the Dashboard | Balance shows the funded ADA; assets listed if any | **T2.5** (matches explorer) |
| 2.3 | Compare to a block explorer (e.g. preview.cardanoscan.io) for that address | Balance matches | T2.5 |
| 2.4 | Switch network (preview→preprod→mainnet) in the dashboard dropdown | Balance refetches per network | T2.3 |
| 2.5 | **Provider** tab → switch provider to **Koios** → **Save & test** | "Connected ✓ tip slot …"; the status badge turns green | T2.3 |
| 2.6 | (Ogmios) Provider tab → **ogmios**, URL `ws://localhost:1337` → **Save & test** | "Connected ✓ …" | T2.3 |
| 2.7 | **Activity** tab (on Blockfrost/Koios) | Recent txs with direction (↓/↑/↻), ±ADA, token deltas, explorer links | history |
| 2.8 | **UTxOs** tab | Every unspent output (ref `txHash#i`, ADA, assets); total matches the balance | listUtxos |

## 3. M3 — Send & Sign

| # | Do | Expect | done-when |
|---|----|--------|-----------|
| 3.1 | Dashboard → **Send** → paste a second testnet address + an amount → **Review** | Approval shows **To / amount / network fee / change** (no opaque blob) | **T3.3** (decode-before-sign) |
| 3.2 | **Approve & Send** | Shows tx hash, then "Submitted — confirming…" → "Confirmed ✓" | **T3.4** (confirmation surfaced) |
| 3.3 | Check the tx on the explorer | Output + fee match the approval | T3.1/T3.2 |
| 3.4 | Start a Send, then **Reject** at the approval | No tx submitted | §1.4 consent |

## 4. M4 — CIP-30 dApp connector

Open the test dApp (http://localhost:5180) with the wallet **unlocked** on preview, a funded wallet,
and a collateral UTxO set (for mint/burn). Every result is logged in the page's Output panel.

| # | Do | Expect | done-when |
|---|----|--------|-----------|
| 4.1 | Top of page | "✓ bob-the-buildooor (CIP-30 v1)" | T0.4/T4.1 |
| 4.2 | **enable()** | A popup window asks to connect, showing the **origin** | **T4.1** |
| 4.3 | Approve. Click again | No prompt the 2nd time (origin allowlisted) | T4.1 |
| 4.4 | **getNetworkId** | `0` (preview) | T4.2 |
| 4.5 | **getUsedAddresses / getChangeAddress / getRewardAddresses** | hex / count logged | T4.2 |
| 4.6 | **getBalance / getUtxos / getCollateral / getExtensions** | non-empty results | T4.2 / T4.6 |
| 4.7 | **signData (login)** | Approval shows the **decoded message**; logs `sig=… key=…` | **T4.5** |
| 4.8 | **Send 2 ₳ → self** | dApp builds the tx; approval shows To/amount/fee; approve → tx hash logged, confirms on the explorer | **T4.3** (build→witness→submit) |
| 4.9 | **Mint 100 TESTDAPP** | Approval decodes a **mint** of 100 under an always-succeeds policy; approve → confirms; the token appears in the dashboard | **T4.3 / M5** |
| 4.10 | **Burn 50 TESTDAPP** (after minting) | Approval decodes a **burn** (−50); approve → confirms; dashboard balance drops to 50 | **M5** |
| 4.11 | At any prompt, **Reject** (or close the window) | dApp logs `UserDeclined`; nothing submitted | §1.4 |
| 4.12 | **signData** while locked, or to a foreign address | Errors with a CIP-30 code (`-2` locked / `2` AddressNotPK) | §9 codes |
| 4.13 ✅ | **Sign + submit 2 chained txs** (CIP-103) — *passed on preview 2026-07-23* | **ONE** approval titled "Bulk signature request" listing **both** txs in full; tx #2 is labelled "Chained: spends output(s) of transaction #1" and shows its input resolved (not "unresolved"); approve → both submitted in order, two hashes logged, both confirm | **T6.5** |
| 4.14 ✅ | **Sign 2 same-input txs** (CIP-103) — *passed on preview 2026-07-23* | Both txs shown; each labelled "Spends the same input(s) as transaction #…"; approve → 2 witness sets logged, nothing submitted | **T6.5** (competing txs are legal input) |
| 4.15 ✅ | **Reject** at a bulk prompt — *passed on preview 2026-07-23* | dApp logs `UserDeclined` (code 2); **no** witness set for any tx in the batch | §1.4 / CIP-103 all-or-nothing |

## 5. M5 — Plutus

Implemented and **verified on preview** via the `scripts/` proof tools (need a configured Ogmios for the
2-pass `evaluateTransaction`): spend (inline datum or CIP-33 ref-script), mint, and ref-script deploy.
Confirmed preview tx hashes: spend `c8ccca0f…`, mint `3353511e…`, ref-script spend `461468ec…`. PlutusData
JSON↔Data↔CBOR is unit-tested. Run the scripts against a preview validator with `BLOCKFROST_API_KEY` set.

---

## Reporting back

For any failure, capture the test-dApp log / popup screenshot / provider-badge error text. The unit
suite (`npm test`, 168 tests) covers the pure logic; this guide covers the browser/chain integration
on top of it.
