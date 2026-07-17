// Shared e2e fixtures (T7.3): a fresh Chromium context with the BUILT extension loaded, its
// extension id, and helpers for the flows most specs need (restore a wallet, unlock the popup).
// Every test gets a brand-new temporary profile — chrome.storage starts empty, so specs must set up
// the wallet state they need (that setup IS part of what we're testing).
import { test as base, chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

/** Deterministic test seed (same one the unit suite uses) — preview/testnet only, never funded on mainnet. */
export const TEST_MNEMONIC = ('abandon '.repeat(23) + 'art').trim();
export const TEST_PASSWORD = 'correct horse battery';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires the pattern
  context: async ({}, use) => {
    // Playwright resolves cwd to the config's directory (the repo root); specs run as ESM (no __dirname).
    const dist = path.resolve(process.cwd(), 'dist');
    const context = await chromium.launchPersistentContext('', {
      // Extensions need the real Chromium channel; its "new headless" supports MV3 extensions.
      channel: 'chromium',
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // The MV3 service worker's URL carries the (profile-specific) extension id.
    let [sw] = context.serviceWorkers();
    sw ??= await context.waitForEvent('serviceworker');
    await use(new URL(sw.url()).host);
  },
});

export { expect };

export function optionsUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/src/options/index.html`;
}
export function popupUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/src/popup/index.html`;
}

/** Run the real onboarding-restore flow: paste the test mnemonic, set the password. */
export async function restoreWallet(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(optionsUrl(extensionId));
  await page.getByRole('button', { name: 'Restore from recovery phrase' }).click();
  await page.locator('textarea').fill(TEST_MNEMONIC);
  await page.getByLabel(/^Password/).fill(TEST_PASSWORD);
  await page.getByLabel('Confirm password').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Restore wallet' }).click();
  await expect(page.getByText('Wallet ready ✓')).toBeVisible();
  await page.close();
}

/**
 * Ensure the wallet is unlocked via the popup UI; returns the (kept-open) popup page showing the
 * dashboard. Handles both states: `wallet.create` leaves the vault UNLOCKED (the session key is
 * cached on create), so right after onboarding there is no password prompt.
 */
export async function unlockPopup(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(popupUrl(extensionId));
  const pw = page.locator('#pw');
  const unlocked = page.getByText('● Unlocked');
  await expect(pw.or(unlocked)).toBeVisible();
  if (await pw.isVisible()) {
    await pw.fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Unlock' }).click();
  }
  await expect(unlocked).toBeVisible();
  return page;
}
