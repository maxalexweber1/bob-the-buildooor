// Node `Buffer` shim for the Ledger SDK (T6.3). `@cardano-foundation/ledgerjs-hw-app-cardano` and
// `@ledgerhq/hw-transport-webhid` call the Node `Buffer` global at runtime; Vite does not polyfill
// Node globals, so we install the standard pure-JS `buffer` package (feross) on globalThis BEFORE the
// SDK executes. Imported first by options/ledgerDevice.ts — page context only, never the SW (the SW
// has no Ledger code; buildooor is Buffer-free).
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: typeof Buffer };
g.Buffer ??= Buffer;
