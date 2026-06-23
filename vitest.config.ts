import { defineConfig } from 'vitest/config';

// Standalone vitest config — intentionally WITHOUT the crxjs plugin, which is for
// building the extension, not for running pure unit tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
});
