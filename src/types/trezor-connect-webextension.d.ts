// Type shims for @trezor/connect-webextension 9.7.3 (T6.4). The published package's `types` field
// points at `src/index.ts`, which is NOT shipped (only build/ + lib/ are) — so TS finds no types at
// the package root. The typed surface DOES ship as lib/index.d.ts; alias the root to it. Runtime
// still resolves to `main` (build/trezor-connect-webextension.js — the prebuilt UMD bundle), which
// exports ONLY the default TrezorConnect object; anything else (PROTO enums, types) must be imported
// type-only from @trezor/connect. Re-check when bumping the package — upstream may fix the field.
declare module '@trezor/connect-webextension' {
  const TrezorConnect: (typeof import('@trezor/connect-webextension/lib/index'))['default'];
  export default TrezorConnect;
}

// Trezor's prebuilt content-script bundle: a plain JS artifact without types, imported purely for
// its side effect (the connect.trezor.io popup relay) from src/content/trezorConnect.ts.
declare module '@trezor/connect-webextension/build/content-script';
