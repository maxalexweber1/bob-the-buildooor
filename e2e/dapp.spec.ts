// dApp bridge e2e (T7.3): the real inpage→content→background→approval-popup chain of the built
// extension, driven from a fake dApp origin (route-fulfilled — no network). Covers CIP-30 injection,
// per-origin consent (§1.4: first enable prompts, approval grants, rejection returns Refused -3,
// re-enable needs no prompt) and the origin display in the trusted popup (§1.6).
import { test, expect, restoreWallet, unlockPopup } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

const DAPP_ORIGIN = 'https://dapp.example';

/** Window shape inside the dApp page (typed locally — the e2e project doesn't import wallet code). */
interface Cip30Window {
  cardano?: Record<
    string,
    {
      apiVersion: string;
      name: string;
      icon: string;
      supportedExtensions: { cip: number }[];
      isEnabled(): Promise<boolean>;
      enable(): Promise<{ getNetworkId(): Promise<number> }>;
    }
  >;
}

async function openDapp(context: BrowserContext): Promise<Page> {
  await context.route(`${DAPP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>fake dapp</title><h1>dapp</h1>' }),
  );
  const page = await context.newPage();
  await page.goto(`${DAPP_ORIGIN}/`);
  // The inpage provider is injected at document_start; wait for it to land on window.cardano.
  await page.waitForFunction(() => (window as unknown as Cip30Window).cardano?.bob !== undefined);
  return page;
}

test('injects the CIP-30 provider with the right identity', async ({ context }) => {
  const dapp = await openDapp(context);
  const info = await dapp.evaluate(() => {
    const provider = (window as unknown as Cip30Window).cardano?.bob;
    return provider ? { apiVersion: provider.apiVersion, name: provider.name } : null;
  });
  expect(info).toEqual({ apiVersion: '1', name: 'bob-the-buildooor' });
});

test('advertises a renderable icon and its supported extensions to the wallet picker', async ({ context }) => {
  const dapp = await openDapp(context);
  const provider = await dapp.evaluate(() => {
    const p = (window as unknown as Cip30Window).cardano?.bob;
    return p ? { icon: p.icon, extensions: p.supportedExtensions } : null;
  });
  // A dApp picker does <img src={icon}>. An EMPTY data URI (the pre-T7.5 placeholder) renders broken
  // and can get the wallet filtered out of the list entirely — so assert real image bytes, not just
  // a prefix. Decoded in the page so the check runs on exactly what a dApp would receive.
  expect(provider?.icon).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]{100,}$/);
  const decoded = await dapp.evaluate(
    (icon) =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('icon failed to decode'));
        img.src = icon;
      }),
    provider?.icon ?? '',
  );
  expect(decoded).toEqual({ width: 128, height: 128 });
  // supportedExtensions is what a CIP-103 dApp checks before offering its bulk flow (T6.5).
  expect(provider?.extensions).toEqual(expect.arrayContaining([{ cip: 95 }, { cip: 103 }]));
});

test('first enable() prompts; approving grants a working API and persists the origin', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);
  await (await unlockPopup(context, extensionId)).close();
  const dapp = await openDapp(context);

  await expect
    .poll(() => dapp.evaluate(() => (window as unknown as Cip30Window).cardano?.bob?.isEnabled()))
    .toBe(false);

  // Kick off enable() (it blocks on user approval) and catch the approval window it opens.
  const approvalPromise = context.waitForEvent('page', (p) => p.url().includes('#approve'));
  const enablePromise = dapp.evaluate(async () => {
    const provider = (window as unknown as Cip30Window).cardano?.bob;
    if (!provider) throw new Error('no provider');
    const api = await provider.enable();
    return api.getNetworkId();
  });

  const approval = await approvalPromise;
  // The trusted popup must display the REAL origin (§1.6) before the user consents.
  await expect(approval.getByText('Connection request')).toBeVisible();
  await expect(approval.getByText(DAPP_ORIGIN)).toBeVisible();
  await approval.getByRole('button', { name: 'Connect', exact: true }).click();

  // enable() resolves to a working API — preview network id is 0.
  expect(await enablePromise).toBe(0);

  // The grant persisted: isEnabled() true, and a second enable() resolves WITHOUT a new prompt.
  await expect
    .poll(() => dapp.evaluate(() => (window as unknown as Cip30Window).cardano?.bob?.isEnabled()))
    .toBe(true);
  let prompted = false;
  context.on('page', () => {
    prompted = true;
  });
  const secondNetworkId = await dapp.evaluate(async () => {
    const provider = (window as unknown as Cip30Window).cardano?.bob;
    if (!provider) throw new Error('no provider');
    return (await provider.enable()).getNetworkId();
  });
  expect(secondNetworkId).toBe(0);
  expect(prompted).toBe(false);
});

test('rejecting the connection returns APIError Refused (-3) and grants nothing', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);
  await (await unlockPopup(context, extensionId)).close();
  const dapp = await openDapp(context);

  const approvalPromise = context.waitForEvent('page', (p) => p.url().includes('#approve'));
  const enableResult = dapp.evaluate(async () => {
    const provider = (window as unknown as Cip30Window).cardano?.bob;
    if (!provider) throw new Error('no provider');
    try {
      await provider.enable();
      return { ok: true as const };
    } catch (e) {
      const err = e as { code?: number; info?: string };
      return { ok: false as const, code: err.code ?? null };
    }
  });

  const approval = await approvalPromise;
  await approval.getByRole('button', { name: 'Reject' }).click();

  expect(await enableResult).toEqual({ ok: false, code: -3 });
  await expect
    .poll(() => dapp.evaluate(() => (window as unknown as Cip30Window).cardano?.bob?.isEnabled()))
    .toBe(false);
});
