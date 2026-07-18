// Standalone Vite config for the CIP-30 test dApp (dev tool — NOT the extension). Serves test-dapp/
// as a plain web page on its own port, so it loads in a normal browser tab with the extension
// installed and talks to window.cardano.bob. Deliberately without @crxjs (that plugin builds the
// MV3 extension). Run: `npm run dev:dapp`.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'test-dapp',
  // Load .env from the repo root so the dApp can read VITE_BLOCKFROST_PROJECT_ID_* — the same keys the
  // extension uses. `envDir` is resolved relative to `root` (test-dapp/), so `..` = the repo root.
  // Blockfrost is CORS-open (Access-Control-Allow-Origin: *) so the in-page tx-building fetch works;
  // Koios preview omits that header and would be blocked.
  envDir: '..',
  // The @harmoniclabs/* packages are CommonJS without an exports/module field — pre-bundle them so
  // the dep optimizer resolves them (same reason as the extension's vite.config.ts).
  optimizeDeps: {
    include: ['@harmoniclabs/buildooor'],
  },
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: '../dist-dapp',
    emptyOutDir: true,
    // Two demo pages: the CIP-30 test dApp and the CIP-113 programmable-token showcase.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./test-dapp/index.html', import.meta.url)),
        cip113: fileURLToPath(new URL('./test-dapp/cip113.html', import.meta.url)),
      },
    },
  },
});
