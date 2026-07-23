// CIP-103 bulk signing e2e (T6.5). Drives the real inpage→content→background→approval chain of the
// BUILT extension with a CHAINED batch: tx#2 spends an output tx#1 has not submitted yet. That is the
// case unit tests can only approximate — here the approval window is a real popup and the witnesses
// come back over the real bridge.
//
// Two invariants are pinned that no unit test can see end-to-end:
//  - the batch prompt RENDERS every transaction (§1.5 — one approval must never mean one blind blob),
//    including the chained input resolved from the batch rather than "could not be resolved";
//  - declining returns NO witness for ANY transaction, not even the one the wallet could have signed.
import {
  Address,
  Tx,
  TxWitnessSet,
  XPub,
  UTxO,
  Value,
  defaultProtocolParameters,
  defaultPreviewGenesisInfos,
} from '@harmoniclabs/buildooor';
import { test, expect, restoreWallet, unlockPopup, optionsUrl, TEST_MNEMONIC } from './fixtures';
import { startMockChain, type MockChain } from './mockKoios';
import { mnemonicToRoot, publicKeyBytes, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { buildSend } from '../src/core/tx/build';
import { toHex } from '../src/core/crypto/encoding';
import type { BrowserContext, Page } from '@playwright/test';

const DAPP_ORIGIN = 'https://dapp.example';
const RECIPIENT =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const FUNDING_TX = 'aa'.repeat(32);

const root = mnemonicToRoot(TEST_MNEMONIC);
const walletAddr0 = baseAddress(root, 'testnet', 0, 0, Role.External);

let mock: MockChain;
test.beforeEach(async () => {
  mock = await startMockChain({
    fundedAddress: walletAddr0,
    lovelace: '10000000',
    txHash: FUNDING_TX,
    submitHashHex: 'dd'.repeat(32),
  });
});
test.afterEach(async () => {
  await mock.close();
});

/**
 * Build the batch a dApp would build: tx#1 pays 5 ₳ to the wallet, tx#2 spends THAT output. tx#2's
 * input only exists once tx#1 lands, so the wallet has to derive tx#1's id and resolve the output
 * from the batch — the whole point of CIP-103 chaining.
 */
function chainedBatch(): { tx1: Tx; tx2: Tx; chainedRef: string } {
  const ctx = {
    protocolParameters: { ...defaultProtocolParameters, utxoCostPerByte: 4310 },
    genesisInfos: defaultPreviewGenesisInfos,
    changeAddress: walletAddr0,
  };
  const funding = new UTxO({
    utxoRef: { id: FUNDING_TX, index: 0 },
    resolved: { address: Address.fromString(walletAddr0), value: Value.lovelaces(10_000_000n) },
  });
  const tx1 = buildSend({ ...ctx, utxos: [funding] }, { toAddress: walletAddr0, lovelace: 5_000_000n });
  const paidToSelf = tx1.body.outputs[0];
  if (!paidToSelf) throw new Error('tx#1 has no output to chain from');
  const produced = new UTxO({ utxoRef: { id: tx1.body.hash.toString(), index: 0 }, resolved: paidToSelf });
  const tx2 = buildSend({ ...ctx, utxos: [produced] }, { toAddress: RECIPIENT, lovelace: 1_000_000n });
  return { tx1, tx2, chainedRef: produced.utxoRef.toString() };
}

/** Point the wallet at the mock provider via the internal settings command (privileged page only). */
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

async function openDapp(context: BrowserContext): Promise<Page> {
  await context.route(`${DAPP_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>dapp</h1>' }),
  );
  const page = await context.newPage();
  await page.goto(`${DAPP_ORIGIN}/`);
  await page.waitForFunction(() => 'bob' in ((window as { cardano?: object }).cardano ?? {}));
  return page;
}

/** In-page `enable({extensions:[{cip:103}]})` + `cip103.signTxs`, failures captured as data. */
type BulkResult = { ok: true; witnesses: string[] } | { ok: false; code: number | null; info: string };
function callSignTxs(dapp: Page, cbors: string[]): Promise<BulkResult> {
  return dapp.evaluate(async (txs) => {
    const provider = (
      window as unknown as {
        cardano: Record<
          string,
          { enable(o: { extensions: { cip: number }[] }): Promise<{ cip103?: { signTxs(t: unknown[]): Promise<string[]> } }> }
        >;
      }
    ).cardano.bob;
    if (!provider) throw new Error('no provider');
    const api = await provider.enable({ extensions: [{ cip: 103 }] });
    if (!api.cip103) return { ok: false as const, code: null, info: 'cip103 namespace not granted' };
    try {
      const witnesses = await api.cip103.signTxs(txs.map((cbor) => ({ cbor })));
      return { ok: true as const, witnesses };
    } catch (e) {
      const err = e as { code?: number; info?: string };
      return { ok: false as const, code: err.code ?? null, info: err.info ?? String(e) };
    }
  }, cbors);
}

/** Collect approval popups as they open; the connect prompt comes first, the batch prompt second. */
function watchApprovals(context: BrowserContext): Page[] {
  const approvals: Page[] = [];
  context.on('page', (p) => {
    if (p.url().includes('#approve')) approvals.push(p);
  });
  return approvals;
}

async function awaitPrompt(approvals: Page[], index: number, result: Promise<BulkResult>): Promise<Page> {
  // Poll for the prompt, but surface an early in-page failure instead of timing out blind — the batch
  // prompt only appears after gap-limit discovery + input resolution.
  await expect
    .poll(
      async () => {
        if (approvals.length > index) return 'prompted';
        const settled = await Promise.race([result, Promise.resolve(null)]);
        return settled && settled.ok === false ? `failed: ${settled.code} ${settled.info}` : 'waiting';
      },
      { timeout: 30_000 },
    )
    .toBe('prompted');
  const prompt = approvals[index];
  if (!prompt) throw new Error(`no approval prompt at index ${index}`);
  return prompt;
}

test('cip103.signTxs: one prompt decodes BOTH txs (chained input resolved) and returns 2 valid witness sets', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);
  await useMockProvider(context, extensionId);
  await (await unlockPopup(context, extensionId)).close();
  const dapp = await openDapp(context);
  const approvals = watchApprovals(context);
  const { tx1, tx2 } = chainedBatch();

  const result = callSignTxs(dapp, [toHex(tx1.toCborBytes()), toHex(tx2.toCborBytes())]);

  const connectPrompt = await awaitPrompt(approvals, 0, result);
  await connectPrompt.getByRole('button', { name: 'Connect', exact: true }).click();

  const batchPrompt = await awaitPrompt(approvals, 1, result);
  // ONE prompt, but every transaction is on it — the §1.5 invariant a batch could quietly break.
  await expect(batchPrompt.getByText('Bulk signature request')).toBeVisible();
  await expect(batchPrompt.getByText(DAPP_ORIGIN)).toBeVisible();
  await expect(batchPrompt.getByText('Transaction 1 of 2')).toBeVisible();
  await expect(batchPrompt.getByText('Transaction 2 of 2')).toBeVisible();
  await expect(batchPrompt.getByText(/Chained: spends output\(s\) of transaction #1/)).toBeVisible();
  // tx#2's recipient is rendered, and its in-batch input did NOT fall back to "unresolved".
  await expect(batchPrompt.getByText(RECIPIENT)).toBeVisible();
  await expect(batchPrompt.getByText(/input\(s\) could not be resolved/)).toHaveCount(0);

  await batchPrompt.getByRole('button', { name: 'Sign all' }).click();

  const signed = await result;
  if (!signed.ok) throw new Error(`signTxs failed: ${signed.code} ${signed.info}`);
  expect(signed.witnesses).toHaveLength(2);

  // Each witness set carries exactly one vkey witness, and it cryptographically verifies against the
  // body hash of ITS OWN transaction — index-aligned, no cross-contamination between batch entries.
  const paymentPub = publicKeyBytes(root, 0, Role.External, 0);
  const xpub = new XPub(new Uint8Array([...paymentPub, ...new Uint8Array(32)])); // verify uses the key half
  [tx1, tx2].forEach((tx, i) => {
    const witnessHex = signed.witnesses[i];
    if (witnessHex === undefined) throw new Error(`no witness set for tx#${i + 1}`);
    const vkeys = TxWitnessSet.fromCbor(witnessHex).vkeyWitnesses ?? [];
    expect(vkeys).toHaveLength(1);
    const w = vkeys[0];
    if (!w) throw new Error(`no vkey witness for tx#${i + 1}`);
    expect(w.vkey.toString()).toBe(toHex(paymentPub));
    expect(xpub.verify(tx.body.hash.toBuffer(), w.signature.toBuffer())).toBe(true);
  });
});

test('cip103.signTxs: declining returns NO witnesses for the whole batch (TxSignError 2)', async ({
  context,
  extensionId,
}) => {
  await restoreWallet(context, extensionId);
  await useMockProvider(context, extensionId);
  await (await unlockPopup(context, extensionId)).close();
  const dapp = await openDapp(context);
  const approvals = watchApprovals(context);
  const { tx1, tx2 } = chainedBatch();

  const result = callSignTxs(dapp, [toHex(tx1.toCborBytes()), toHex(tx2.toCborBytes())]);
  await (await awaitPrompt(approvals, 0, result)).getByRole('button', { name: 'Connect', exact: true }).click();
  const batchPrompt = await awaitPrompt(approvals, 1, result);
  await batchPrompt.getByRole('button', { name: 'Reject' }).click();

  // All-or-nothing: tx#1 spends a wallet-owned on-chain UTxO and would have signed fine on its own.
  const declined = await result;
  expect(declined.ok).toBe(false);
  if (declined.ok) throw new Error('expected a decline');
  expect(declined.code).toBe(2); // TxSignError.UserDeclined
});
