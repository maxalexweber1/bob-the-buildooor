# Live Verification Guide

Manual end-to-end checks for the loaded extension on **preview testnet**. These are the steps that
can't run headlessly (real Chrome + service worker + chain). Each item maps to a plan `done-when`.

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
Pin the toolbar icon. (For HMR dev instead: `npm run dev`, then load `dist/`.)

Serve the test dApp (separate terminal):
```bash
npx serve test-dapp    # or: python -m http.server -d test-dapp 8080
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
| 2.5 | Options → Settings → switch provider to **Koios** → **Test connection** | "Connected ✓ tip slot …" | T2.3 |
| 2.6 | (Ogmios) Settings → provider **ogmios**, URL `ws://localhost:1337` → **Test connection** | "Connected ✓ …" | T2.3 |

## 3. M3 — Send & Sign

| # | Do | Expect | done-when |
|---|----|--------|-----------|
| 3.1 | Dashboard → **Send** → paste a second testnet address + an amount → **Review** | Approval shows **To / amount / network fee / change** (no opaque blob) | **T3.3** (decode-before-sign) |
| 3.2 | **Approve & Send** | Shows tx hash, then "Submitted — confirming…" → "Confirmed ✓" | **T3.4** (confirmation surfaced) |
| 3.3 | Check the tx on the explorer | Output + fee match the approval | T3.1/T3.2 |
| 3.4 | Start a Send, then **Reject** at the approval | No tx submitted | §1.4 consent |

## 4. M4 — CIP-30 dApp connector

Open the served test dApp (e.g. http://localhost:3000) with the wallet **unlocked**.

| # | Do | Expect | done-when |
|---|----|--------|-----------|
| 4.1 | Top of page | "✓ Found bob-the-buildooor (apiVersion 1)" | T0.4/T4.1 |
| 4.2 | **enable()** | A popup window asks to connect, showing the **origin** | **T4.1** |
| 4.3 | Approve. Click again | No prompt the 2nd time (origin allowlisted) | T4.1 |
| 4.4 | **getNetworkId** | `0` (preview) | T4.2 |
| 4.5 | **getUsedAddresses / getChangeAddress / getRewardAddresses** | hex strings | T4.2 |
| 4.6 | **getBalance / getUtxos** | hex cbor results | T4.2 |
| 4.7 | **signData** | Approval shows the **decoded message**; result logs `signature=… key=…` | **T4.5** |
| 4.8 | **signData** while locked, or to a foreign address | Errors with a CIP-30 code (`-2` locked / `2` AddressNotPK) | §9 codes |
| 4.9 | Build an unsigned tx the wallet owns inputs for (e.g. via Send "Review" → grab the cbor, or a dApp), paste → **signTx** | Approval shows the decoded summary; returns a **witness-set** hex (not a full tx) | **T4.3** |
| 4.10 | At any signTx/signData prompt, **Reject** (or close the window) | dApp gets `UserDeclined` | §1.4 |

## 5. M5 — Plutus (partial)

T5.1 (PlutusData JSON↔Data↔CBOR) is unit-tested. The 2-pass build (T5.2–T5.4) is **not implemented yet**
— it needs a live Ogmios `evaluateTransaction` to verify ex-units + `scriptDataHash` before it can be
trusted with funds. Once an Ogmios endpoint is configured (step 2.6 passing), that work can be built
and verified against a real preview validator.

---

## Reporting back

If you run these and paste the **test-dApp log** + any popup screenshots (or just describe failures),
I can fix issues without a browser on my side. The unit suite (`npm test`, 129 tests) already covers
the pure logic; this guide covers the browser/chain integration it can't reach.
