import { defineConfig } from 'vitest/config';

// Standalone vitest config — intentionally WITHOUT the crxjs plugin, which is for
// building the extension, not for running pure unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    // Pure-JS BIP32-Ed25519 derivation tests (address/discovery/hw) legitimately take 5-10s of CPU;
    // vitest 4 enforces the 5s default strictly (vitest 2 let them pass), so give crypto room.
    testTimeout: 30_000,
  },
});
