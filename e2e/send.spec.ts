// Send + signData e2e over a mock chain provider (T7.3 follow-up). Points the wallet's Koios
// provider at a local mock server (extension-SW fetches aren't Playwright-routable; localhost +
// permissive CORS needs no host permission), then exercises the two flows the network-free specs
// couldn't reach:
//  - the full §1.5 send path: form → decoded review → approve → sign → submit — then decodes the
//    ACTUAL submitted CBOR in Node and cryptographically verifies the witness;
//  - dApp signData: enable → per-call approval (§1.4) → COSE_Sign1 verified against the wallet key.
import { Tx, XPub } from '@harmoniclabs/buildooor';
import { test, expect, restoreWallet, unlockPopup, optionsUrl, TEST_MNEMONIC } from './fixtures';
import { startMockChain, type MockChain } from './mockKoios';
import { mnemonicToRoot, publicKeyBytes, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { verifyCoseSign1 } from '../src/core/cose/verify';
import { toHex, utf8ToBytes } from '../src/core/crypto/encoding';
import type { BrowserContext, Page } from '@playwright/test';

const RECIPIENT =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const FUNDING_TX = 'aa'.repeat(32);
const SUBMIT_HASH = 'dd'.repeat(32);

const root = mnemonicToRoot(TEST_MNEMONIC);
const walletAddr0 = baseAddress(root, 'testnet', 0, 0, Role.External);

let mock: MockChain;
test.beforeEach(async () => {
  mock = await startMockChain({
    fundedAddress: walletAddr0,
    lovelace: '10000000',
    txHash: FUNDING_TX,
    submitHashHex: SUBMIT_HASH,
  });
});
test.afterEach(async () => {
  await mock.close();
});

/** Point the wallet at the mock provider via the internal settings command (from a privileged page). */
async function useMockProvider(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(optionsUrl(extensionId));
  await page.evaluate(
    (koiosUrl) =>
      chrome.runtime.sendMessage({
        target: 'bob:internal',
        command: { type: 'updateSettings', patch: { providerKind: 'koios', koiosUrl } },
      }),
    mock.url,
  );
  await page.close();
}

test('send: form → decoded review → approve → the SUBMITTED CBOR matches what was approved (§1.5)', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);
  await useMockProvider(context, extensionId);
  const popup = await unlockPopup(context, extensionId);

  // With the mock provider the dashboard shows the funded balance.
  await expect(popup.getByText('10 ₳')).toBeVisible();

  await popup.getByRole('button', { name: 'Send' }).click();
  await popup.locator('textarea').fill(RECIPIENT);
  await popup.getByPlaceholder('0.0').fill('2');
  await popup.getByRole('button', { name: 'Review' }).click();

  // Decode-before-sign: the review shows the full recipient address, the amount, a real fee.
  await expect(popup.getByText('Review transaction')).toBeVisible();
  await expect(popup.getByText(RECIPIENT)).toBeVisible();
  await expect(popup.getByText('2 ₳')).toBeVisible();
  await expect(popup.getByText('Network fee')).toBeVisible();

  await popup.getByRole('button', { name: 'Approve & Send' }).click();
  await expect(popup.getByText(/Confirmed ✓|Submitted/)).toBeVisible();
  await expect(popup.getByText(SUBMIT_HASH)).toBeVisible();

  // The mock captured the real submitted bytes — decode and hold them against what was approved.
  expect(mock.submitted).toHaveLength(1);
  const submittedHex = mock.submitted[0];
  if (!submittedHex) throw new Error('nothing submitted');
  const tx = Tx.fromCbor(submittedHex);
  const [toOut] = tx.body.outputs;
  expect(toOut?.address.toString()).toBe(RECIPIENT);
  expect(toOut?.value.lovelaces).toBe(2_000_000n);
  expect(tx.body.inputs[0]?.utxoRef.id.toString()).toBe(FUNDING_TX);

  // Exactly one vkey witness, and it cryptographically verifies: the wallet's payment key 0 signed
  // the body hash of THIS transaction (what the user approved is what was signed and submitted).
  const witnesses = tx.witnesses.vkeyWitnesses ?? [];
  expect(witnesses).toHaveLength(1);
  const witness = witnesses[0];
  if (!witness) throw new Error('missing witness');
  const paymentPub = publicKeyBytes(root, 0, Role.External, 0);
  expect(witness.vkey.toString()).toBe(toHex(paymentPub));
  const bodyHash = tx.body.hash.toBuffer();
  const chainCodeIrrelevant = new Uint8Array(32); // XPub verify uses only the key half
  const xpub = new XPub(new Uint8Array([...paymentPub, ...chainCodeIrrelevant]));
  expect(xpub.verify(bodyHash, witness.signature.toBuffer())).toBe(true);
});

test('dApp signData: per-call approval, returned COSE_Sign1 verifies against the wallet key (§1.4)', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);
  await useMockProvider(context, extensionId);
  await (await unlockPopup(context, extensionId)).close();

  await context.route('https://dapp.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>dapp</h1>' }),
  );
  const dapp = await context.newPage();
  await dapp.goto('https://dapp.example/');
  await dapp.waitForFunction(() => 'bob' in ((window as { cardano?: object }).cardano ?? {}));

  const payloadHex = toHex(utf8ToBytes('e2e sign-in'));
  const approvals: Page[] = [];
  context.on('page', (p) => {
    if (p.url().includes('#approve')) approvals.push(p);
  });

  // Capture failures as data (an in-page throw would otherwise surface only as a generic evaluate
  // error after the prompt-polling below times out — useless for diagnosis).
  const resultPromise = dapp.evaluate(
    async ({ addr, payload }) => {
      const cardano = (
        window as unknown as {
          cardano: Record<string, { enable(): Promise<{ signData(a: string, p: string): Promise<unknown> }> }>;
        }
      ).cardano;
      const provider = cardano.bob;
      if (!provider) throw new Error('no provider');
      const api = await provider.enable();
      try {
        const signed = (await api.signData(addr, payload)) as { signature: string; key: string };
        return { ok: true as const, ...signed };
      } catch (e) {
        const err = e as { code?: number; info?: string };
        return { ok: false as const, code: err.code ?? null, info: err.info ?? String(e) };
      }
    },
    { addr: walletAddr0, payload: payloadHex },
  );

  // Two prompts, in order: connect, then the per-call signData approval (§1.4 — never skipped).
  await expect.poll(() => approvals.length).toBeGreaterThanOrEqual(1);
  const connectPrompt = approvals[0];
  if (!connectPrompt) throw new Error('no connect prompt');
  await connectPrompt.getByRole('button', { name: 'Connect', exact: true }).click();

  // The per-call signData prompt (§1.4) — unless the call already failed, in which case surface WHY.
  // Generous timeout: signData first runs full gap-limit discovery (~40 BIP32 derivations) to prove
  // address ownership before it ever prompts.
  await expect
    .poll(
      async () => {
        if (approvals.length >= 2) return 'prompted';
        const settled = await Promise.race([resultPromise.then((r) => r), Promise.resolve(null)]);
        return settled && settled.ok === false ? `failed: ${settled.code} ${settled.info}` : 'waiting';
      },
      { timeout: 30_000 },
    )
    .toBe('prompted');
  const signPrompt = approvals[1];
  if (!signPrompt) throw new Error('no signData prompt');
  await expect(signPrompt.getByText('Sign message')).toBeVisible();
  await signPrompt.getByRole('button', { name: 'Sign', exact: true }).click();

  const result = await resultPromise;
  if (!result.ok) throw new Error(`signData failed: ${result.code} ${result.info}`);
  // The COSE_Sign1 verifies against the returned COSE_Key, carries our payload, and the key IS the
  // wallet's payment key for the address it claimed to sign for.
  const verified = verifyCoseSign1(result.signature, result.key);
  expect(verified.valid).toBe(true);
  expect(verified.payloadUtf8).toBe('e2e sign-in');
  expect(result.key).toContain(toHex(publicKeyBytes(root, 0, Role.External, 0)));
});
