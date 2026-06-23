import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

// @crxjs/vite-plugin wires the MV3 entry points (background SW, content scripts,
// popup HTML) straight from manifest.config.ts and auto-registers any
// `?script`-imported file as a web-accessible resource (used for inpage injection).
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  // The @harmoniclabs/* packages are CommonJS without an `exports`/`module` field —
  // pre-bundle them so Vite's dep optimizer resolves them cleanly in dev.
  optimizeDeps: {
    include: ['@harmoniclabs/buildooor', '@scure/bip39'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Chrome rejects extension files whose names start with "_" (reserved). Rollup names the
        // CommonJS-interop chunk "_commonjsHelpers-…"; strip any leading underscore so dist/ loads.
        chunkFileNames: (info) => `assets/${(info.name || 'chunk').replace(/^_+/, '')}-[hash].js`,
      },
    },
  },
  server: {
    // crxjs HMR for MV3
    port: 5173,
    strictPort: true,
    hmr: { port: 5173 },
  },
});
