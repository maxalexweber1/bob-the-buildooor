// Playwright e2e config (EXECUTION_PLAN T7.3). Drives the BUILT extension (dist/) in Chromium —
// run `npm run build` first (or use `npm run e2e`, which chains it). Kept separate from vitest:
// unit tests are `test/**/*.test.ts`; e2e specs live in `e2e/*.spec.ts`.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  // Each spec launches its own persistent context with the extension loaded; extension windows and
  // chrome.storage are per-context, so parallel workers would not conflict — but the flows are
  // short and serial keeps CI output readable and resource use low.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // No baseURL: pages are chrome-extension:// URLs and route-fulfilled fake dApp origins.
    trace: 'retain-on-failure',
  },
});
