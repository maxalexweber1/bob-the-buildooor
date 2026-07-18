// Test-dApp smoke e2e (T7.3): loads the BUILT test dApp (dist-dapp/, produced by `npm run build:dapp`)
// in the extension context, served from a fake http origin so the content script injects the CIP-30
// provider. Drives the real harness — provider detection, enable() approval, and a getBalance read —
// against the mock chain. Write flows (send/mint/burn) need real preview chain data + a funded
// wallet, so they stay manual; this proves the harness loads, connects, and reads end-to-end.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, restoreWallet, unlockPopup, optionsUrl } from './fixtures';
import { startMockChain, type MockChain } from './mockKoios';
import { mnemonicToRoot, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import type { BrowserContext } from '@playwright/test';

const DAPP_ORIGIN = 'https://testdapp.local';
const DIST = path.resolve(process.cwd(), 'dist-dapp');

const root = mnemonicToRoot(('abandon '.repeat(23) + 'art').trim());
const walletAddr0 = baseAddress(root, 'testnet', 0, 0, Role.External);

let mock: MockChain;
test.beforeEach(async () => {
  mock = await startMockChain({ fundedAddress: walletAddr0, lovelace: '10000000', txHash: 'aa'.repeat(32), submitHashHex: 'dd'.repeat(32) });
});
test.afterEach(async () => {
  await mock.close();
});

/** Serve dist-dapp/ from a fake origin via route fulfilment (built file → response). */
async function serveDapp(context: BrowserContext): Promise<void> {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error('dist-dapp/ missing — run `npm run build:dapp` first (the e2e npm script chains it)');
  }
  await context.route(`${DAPP_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file)) {
      void route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    void route.fulfill({ contentType: type, body: fs.readFileSync(file) });
  });
}

async function useMockProvider(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(
    (koiosUrl) =>
      chrome.runtime.sendMessage({ target: 'bob:internal', command: { type: 'updateSettings', patch: { providerKind: 'koios', koiosUrl } } }),
    mock.url,
  );
  await page.close();
}

test('test dApp loads, detects the provider, connects, and reads balance', async ({ context, extensionId }) => {
  await restoreWallet(context, extensionId);
  await useMockProvider(context, extensionId);
  await (await unlockPopup(context, extensionId)).close();
  await serveDapp(context);

  const dapp = await context.newPage();
  await dapp.goto(`${DAPP_ORIGIN}/`);

  // Provider detection resolves to the injected wallet.
  await expect(dapp.locator('#provider-state')).toHaveText(/bob-the-buildooor/);

  // enable() opens the approval popup — approve it, then the harness reports "API granted".
  const approvalPromise = context.waitForEvent('page', (p) => p.url().includes('#approve'));
  await dapp.getByRole('button', { name: 'enable()' }).click();
  const approval = await approvalPromise;
  await approval.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(dapp.locator('#log')).toContainText('API granted');

  // getBalance goes wallet → mock chain and logs a non-empty CBOR result.
  await dapp.getByRole('button', { name: 'getBalance' }).click();
  await expect(dapp.locator('#log')).toContainText('getBalance');
  await expect(dapp.locator('#log .err')).toHaveCount(0);
});
