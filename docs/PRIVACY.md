# Privacy Policy — bob-the-buildooor

_Last updated: 2026-06-24_

bob-the-buildooor is a self-custody Cardano wallet that runs entirely as a browser extension on
your device. This policy describes what the extension does and does not do with your data.

## Summary

**We do not collect, transmit, sell, or share any personal data.** There is no analytics, no
telemetry, no account, and no backend server operated by us. Your keys never leave your device.

## What is stored, and where

All data is stored **locally** on your device using the browser's extension storage
(`chrome.storage.local` / `chrome.storage.session`). Nothing is sent to us.

| Data | Storage | Notes |
|---|---|---|
| Encrypted seed/key vault | `chrome.storage.local` | Encrypted with a key derived from your password (PBKDF2-HMAC-SHA256, AES-256-GCM). Only ciphertext is ever stored. |
| Derived unlock key (while unlocked) | `chrome.storage.session` | In-memory only; cleared when the browser closes or the wallet auto-locks. The password and seed are never stored. |
| Settings (network, chain-data provider URL/key, authorized dApp origins) | `chrome.storage.local` | Your configuration. Any API keys you enter are stored locally and used only to talk to the provider you chose. |

We never store your password, mnemonic/seed phrase, or any private key in plaintext anywhere.

## Network connections

The extension connects **only** to the blockchain data provider **you configure** (e.g. Blockfrost,
Koios, or your own Ogmios/Kupo node) to read balances and submit transactions you approve. These are
third-party services governed by their own privacy policies; the extension sends them only the data
required for the requested operation (e.g. an address to look up, or a signed transaction to submit).
It contacts no other servers.

## dApp connections (CIP-30)

When you connect the wallet to a website (dApp), that site can request your addresses and ask you to
sign transactions or data. **Every connection and every signature requires your explicit approval** in
the extension's own trusted popup. The extension shares with a dApp only what you approve, and only
with origins you have authorized.

## Permissions

See `docs/STORE.md` for a per-permission justification. None of the permissions are used to collect or
transmit personal data.

## Changes

Material changes to this policy will be reflected in the extension's release notes and this file's
"Last updated" date.

## Contact

Security or privacy concerns: open a private advisory on the project repository.
