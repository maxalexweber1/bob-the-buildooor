// Wallet lifecycle e2e (T7.3): onboarding-restore → unlock → lock, wrong password, and the
// vault-at-rest invariants (§1.1/§1.2) checked against the real chrome.storage of the built
// extension. Network-free: no provider key is configured, so chain fetches fail gracefully —
// the dashboard still renders its unlocked state (asserted), just without a balance.
import { test, expect, restoreWallet, optionsUrl, popupUrl, TEST_PASSWORD, TEST_MNEMONIC } from './fixtures';

test('restore → lock → unlock lifecycle', async ({ context, extensionId }) => {
  await restoreWallet(context, extensionId);

  const popup = await context.newPage();
  await popup.goto(popupUrl(extensionId));

  // Restoring caches the session key, so the wallet starts UNLOCKED — then Lock it.
  await expect(popup.getByText('● Unlocked')).toBeVisible();
  await expect(popup.getByText('Total balance')).toBeVisible();
  await popup.getByRole('button', { name: 'Lock' }).click();
  await expect(popup.locator('#pw')).toBeVisible();

  // Wrong password is rejected with the (deliberately generic) error, and stays locked.
  await popup.locator('#pw').fill('definitely-wrong');
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await expect(popup.getByText('wrong password')).toBeVisible();

  // Correct password unlocks back to the dashboard.
  await popup.locator('#pw').fill(TEST_PASSWORD);
  await popup.getByRole('button', { name: 'Unlock' }).click();
  await expect(popup.getByText('● Unlocked')).toBeVisible();
});

test('vault at rest: storage.local carries no plaintext secrets, never localStorage (§1.1/§1.2)', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);

  const page = await context.newPage();
  await page.goto(optionsUrl(extensionId));

  const local = await page.evaluate(() => chrome.storage.local.get(null));
  const dump = JSON.stringify(local);
  // The vault blob must exist…
  expect(dump.length).toBeGreaterThan(100);
  // …but neither the mnemonic (full phrase + its distinctive tail) nor the password may appear
  // anywhere in persistent storage, in any key or value.
  expect(dump).not.toContain(TEST_MNEMONIC);
  expect(dump).not.toContain('abandon art');
  expect(dump).not.toContain(TEST_PASSWORD);

  // The options page must not have used localStorage for anything (§1.2).
  const localStorageKeys = await page.evaluate(() => Object.keys(window.localStorage));
  expect(localStorageKeys).toEqual([]);
});

test('onboarding create-flow gates on the backup confirmation', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(optionsUrl(extensionId));
  await page.getByRole('button', { name: 'Create a new wallet' }).click();

  // 24 words are shown; Continue is disabled until the "I have written down" ack.
  await expect(page.locator('ol li')).toHaveCount(24);
  const cont = page.getByRole('button', { name: 'Continue' });
  await expect(cont).toBeDisabled();
  await page.getByRole('checkbox').check();
  await expect(cont).toBeEnabled();
  await cont.click();

  // The confirm step demands the right words: wrong input keeps Continue disabled.
  await expect(page.getByText('Confirm your phrase')).toBeVisible();
  await page.getByLabel(/Word #\d+/).first().fill('wrongword');
  await page.getByLabel(/Word #\d+/).nth(1).fill('alsowrong');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});
