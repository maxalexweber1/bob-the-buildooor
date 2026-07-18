// CIP-113 programmable-token demo dApp (dev tool, M9 showcase). Loaded like the CIP-30 test dApp
// (npm run dev:dapp → /cip113.html) with the extension installed. Demonstrates the full programmable
// -token story from a dApp's point of view:
//   1. derive the user's PROGRAMMABLE address (shared base script + their stake credential) from
//      nothing but CIP-30 getRewardAddresses();
//   2. read its balance and prove each token's registration against the on-chain registry
//      (NFT-authenticated RegistryNode — core/cip113/registry);
//   3. build a real transfer (two withdraw-zero validator invocations, registry + protocol-params
//      reference inputs — core/cip113/transfer), have the WALLET decode & sign it (approval popup:
//      script inputs, withdrawals, required signer), merge the witness set, submit.
//
// Deployment constants come from scripts/cip113-params.local.json (emitted by scripts/cip113-deploy.cjs,
// gitignored — the fixture deployment is per-machine). Without it the page loads in read-nothing mode
// and says how to create one. Chain data via CORS-open Blockfrost preview, like main.ts.
import { Address, TxWitnessSet, UTxO, type Tx } from '@harmoniclabs/buildooor';
import { BlockfrostProvider } from '../src/background/provider/blockfrost';
import { cip113ParamsFor, type Cip113Params } from '../src/core/cip113/params';
import { programmableTokenAddress } from '../src/core/cip113/address';
import { findRegistryNode, type RegistryNodeRef } from '../src/core/cip113/registry';
import {
  buildProgrammableTransfer,
  parseUtxoRef,
  recipientProgrammableAddress,
} from '../src/core/cip113/transfer';
import { fromHex, toHex } from '../src/core/crypto/encoding';
import { submitWithDiagnostics } from './submitDiag';

const WALLET_KEY = 'bob';

// ---- CIP-30 plumbing (mirrors main.ts; kept local so the two demo pages stay independent) --------
interface Cip30Api {
  getUtxos(amount?: string): Promise<string[] | null>;
  getCollateral(params?: { amount?: string }): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  getRewardAddresses(): Promise<string[]>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  submitTx(tx: string): Promise<string>;
}
interface Cip30Provider {
  apiVersion: string;
  name: string;
  enable(): Promise<Cip30Api>;
}

let api: Cip30Api | null = null;
const provider = () => {
  const p = (window as unknown as { cardano?: Record<string, Cip30Provider> }).cardano?.[WALLET_KEY];
  if (!p) throw new Error('window.cardano.bob not found — is the extension loaded on this page?');
  return p;
};
const requireApi = () => {
  if (!api) throw new Error('connect first');
  return api;
};

const BF_KEY = import.meta.env.VITE_BLOCKFROST_PROJECT_ID_PREVIEW as string | undefined;
const chain = new BlockfrostProvider('preview', BF_KEY ?? '');
let ppCache: ReturnType<typeof chain.getProtocolParameters> | null = null;
const protocolParams = () => {
  if (!ppCache) {
    ppCache = chain.getProtocolParameters();
    ppCache.catch(() => {
      ppCache = null;
    });
  }
  return ppCache;
};

// ---- deployment params (gitignored local artifact; absent → read-nothing mode) -------------------
const paramFiles = import.meta.glob('../scripts/cip113-params.local.json', { eager: true, import: 'default' });
const rawParams = Object.values(paramFiles)[0] as Record<string, unknown> | undefined;
const params: Cip113Params | undefined = cip113ParamsFor(
  'preview',
  rawParams as Parameters<typeof cip113ParamsFor>[1],
);

// ---- tiny DOM/log helpers ------------------------------------------------------------------------
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing`);
  return found as T;
}
const logEl = el<HTMLDivElement>('log');
function log(msg: string, cls = ''): void {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
  log(`→ ${label}…`, 'dim');
  const t0 = performance.now();
  const ms = () => `${Math.round(performance.now() - t0)} ms`;
  try {
    const r = await fn();
    const short = typeof r === 'string' ? r : JSON.stringify(r);
    log(`✓ ${label} (${ms()}): ${short.length > 160 ? short.slice(0, 160) + '…' : short}`, 'ok');
  } catch (e) {
    const info = (e as { info?: string }).info ?? (e as Error).message ?? JSON.stringify(e);
    log(`✗ ${label} (${ms()}): ${info}`, 'err');
  }
}

// ---- programmable-token state --------------------------------------------------------------------
interface TokenRow {
  unit: string;
  policyId: string;
  nameUtf8: string | null;
  quantity: bigint;
  registered: boolean;
  transferConfigured: boolean;
}

let stakeKeyHash: Uint8Array | null = null;
let progAddr: string | null = null;
let progUtxos: UTxO[] = [];
let tokens: TokenRow[] = [];

function decodeName(nameHex: string): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(fromHex(nameHex));
    return /^[\x20-\x7e]+$/.test(s) && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

/** CIP-30 getRewardAddresses → 29-byte hex reward address; byte 0 is the header, 1..28 the key hash. */
function stakeHashFromRewardAddress(hex: string): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== 29) throw new Error(`unexpected reward address length ${bytes.length}`);
  return bytes.slice(1);
}

async function refresh(): Promise<void> {
  const p = mustParams();
  if (!stakeKeyHash) throw new Error('connect first');
  progAddr = programmableTokenAddress(p.programmableLogicBase, stakeKeyHash, 'testnet');
  el('prog-addr').textContent = progAddr;

  progUtxos = await chain.getUtxos(progAddr);
  // Aggregate per unit; then prove registration per policy against the on-chain registry.
  const byUnit = new Map<string, bigint>();
  for (const u of progUtxos) {
    const json = u.resolved.value.toJson() as Record<string, Record<string, string>>;
    for (const [policy, names] of Object.entries(json)) {
      if (policy === '') continue; // lovelace
      for (const [name, qty] of Object.entries(names)) {
        const unit = policy + name;
        byUnit.set(unit, (byUnit.get(unit) ?? 0n) + BigInt(qty));
      }
    }
  }
  const nodeByPolicy = new Map<string, RegistryNodeRef | null>();
  tokens = [];
  for (const [unit, quantity] of byUnit) {
    const policyId = unit.slice(0, 56);
    if (!nodeByPolicy.has(policyId)) {
      nodeByPolicy.set(policyId, await findRegistryNode(policyId, p, chain));
    }
    tokens.push({
      unit,
      policyId,
      nameUtf8: decodeName(unit.slice(56)),
      quantity,
      registered: Boolean(nodeByPolicy.get(policyId)),
      transferConfigured: p.transfer?.scripts.transferLogic[policyId] !== undefined,
    });
  }
  renderTokens();
}

function renderTokens(): void {
  const box = el('tokens');
  box.textContent = '';
  if (tokens.length === 0) {
    const d = document.createElement('div');
    d.className = 'muted';
    d.textContent = 'No programmable tokens at this address.';
    box.appendChild(d);
  }
  for (const t of tokens) {
    const row = document.createElement('div');
    row.className = 'tokrow';
    const name = document.createElement('span');
    name.style.flex = '1';
    name.textContent = `${t.nameUtf8 ?? t.unit.slice(56, 68) + '…'} `;
    const tag = document.createElement('span');
    tag.className = `tag ${t.registered ? 'reg' : 'unreg'}`;
    tag.textContent = t.registered ? 'registry ✓ (NFT-authenticated)' : 'NOT in registry';
    const qty = document.createElement('span');
    qty.textContent = t.quantity.toString();
    name.appendChild(tag);
    row.append(name, qty);
    box.appendChild(row);
  }
  const sel = el<HTMLSelectElement>('unit');
  sel.textContent = '';
  const transferable = tokens.filter((t) => t.registered && t.transferConfigured);
  for (const t of transferable) {
    const opt = document.createElement('option');
    opt.value = t.unit;
    opt.textContent = `${t.nameUtf8 ?? t.unit.slice(0, 16) + '…'} (${t.quantity})`;
    sel.appendChild(opt);
  }
  const ready = transferable.length > 0;
  sel.disabled = !ready;
  el<HTMLButtonElement>('transfer').disabled = !ready;
  if (!ready && tokens.length > 0) {
    log('no token is both registered AND has a configured transfer-logic script — transfer disabled', 'dim');
  }
  updateRecipientPreview();
}

/** Live preview: where the tokens will actually land (the recipient's PROGRAMMABLE address). */
function updateRecipientPreview(): void {
  const p = params;
  const out = el('recipient-prog');
  const addr = el<HTMLTextAreaElement>('recipient').value.trim();
  if (!p || !addr) {
    out.textContent = '';
    return;
  }
  try {
    out.textContent = `→ tokens land at their programmable address: ${recipientProgrammableAddress(p, addr, 'testnet')}`;
  } catch (e) {
    out.textContent = `⚠ ${e instanceof Error ? e.message : 'invalid recipient'}`;
  }
}

function mustParams(): Cip113Params {
  if (!params) {
    throw new Error(
      'no CIP-113 deployment params — run `node scripts/cip113-deploy.cjs` (see docs/TESTING.md) to create scripts/cip113-params.local.json',
    );
  }
  return params;
}

// ---- the transfer itself -------------------------------------------------------------------------
async function doTransfer(a: Cip30Api): Promise<string> {
  const p = mustParams();
  const transfer = p.transfer;
  if (!transfer) throw new Error('params carry no transfer section (redeploy with scripts)');
  if (!stakeKeyHash || !progAddr) throw new Error('connect first');

  const unit = el<HTMLSelectElement>('unit').value;
  const recipient = el<HTMLTextAreaElement>('recipient').value.trim();
  const qtyText = el<HTMLInputElement>('qty').value.trim();
  if (!/^\d+$/.test(qtyText) || BigInt(qtyText) <= 0n) throw new Error('quantity must be a positive integer');
  const policyId = unit.slice(0, 56);

  // On-chain truth, resolved FRESH per build (T9.1 rule — registry nodes move on every update).
  log('   resolving registry node + protocol-params UTxO (reference inputs)…', 'dim');
  const registryNode = await findRegistryNode(policyId, p, chain);
  if (!registryNode?.utxo) throw new Error('token is not registered in the CIP-113 registry');
  const [protocolParamsUtxo] = await chain.resolveUtxos([parseUtxoRef(transfer.protocolParamsRef)]);
  if (!protocolParamsUtxo) throw new Error('the configured protocol-params UTxO does not exist (stale deployment?)');

  // Sources: single-policy UTxOs only (mirrors the wallet's own v1 rule — no other programmable
  // token may ride along into change).
  const sourceUtxos = progUtxos.filter((u) => {
    const json = u.resolved.value.toJson() as Record<string, Record<string, string>>;
    const policies = Object.keys(json).filter((k) => k !== '');
    return policies.length === 1 && json[policyId]?.[unit.slice(56)] !== undefined;
  });
  if (sourceUtxos.length === 0) throw new Error('no spendable single-token UTxOs at the programmable address');

  // Regular wallet UTxOs fund fee/min-ADA; an ADA-only UTxO is the collateral.
  const [collateralHex] = await a.getCollateral({ amount: '2000000' });
  if (!collateralHex) throw new Error('no collateral — the wallet has no ADA-only UTxO');
  const collateral = UTxO.fromCbor(collateralHex);
  const funding = (((await a.getUtxos()) ?? []).map((h) => UTxO.fromCbor(h))).filter(
    (u) => u.utxoRef.toString() !== collateral.utxoRef.toString(),
  );
  const changeAddress = Address.fromBytes(fromHex(await a.getChangeAddress())).toString();

  log('   building transfer (2 withdraw-zero validators, 2 reference inputs)…', 'dim');
  const tx: Tx = buildProgrammableTransfer({
    protocolParameters: await protocolParams(),
    genesisInfos: await chain.getGenesisInfos(),
    network: 'testnet',
    cip113: p,
    registryNode,
    registryNodeUtxo: registryNode.utxo,
    protocolParamsUtxo,
    sourceUtxos,
    unit,
    quantity: BigInt(qtyText),
    recipientBaseAddress: recipient,
    senderProgrammableAddress: progAddr,
    senderStakeKeyHash: stakeKeyHash,
    collateral,
    fundingUtxos: funding,
    changeAddress,
  });

  // The wallet's approval popup now decodes THIS tx: script inputs, both zero-withdrawals, the
  // collateral at risk, and the extra required signer (your stake key = ownership authorization).
  log('   tx built — requesting signature (wallet popup)…', 'dim');
  const wsHex = await a.signTx(toHex(tx.toCborBytes()), true);
  const ws = TxWitnessSet.fromCbor(wsHex);
  for (const vk of ws.vkeyWitnesses ?? []) tx.addVKeyWitness(vk);
  log('   signed — submitting…', 'dim');
  const hash = await submitWithDiagnostics(BF_KEY, a, toHex(tx.toCborBytes()), log);
  void refresh().catch(() => undefined);
  return hash;
}

// ---- wiring --------------------------------------------------------------------------------------
el('connect').addEventListener('click', () =>
  run('enable()', async () => {
    api = await provider().enable();
    const [reward] = await api.getRewardAddresses();
    if (!reward) throw new Error('wallet returned no reward address');
    stakeKeyHash = stakeHashFromRewardAddress(reward);
    // Prefill the recipient with the user's own base address → a safe self-transfer demo.
    const [used] = await api.getUsedAddresses();
    const own = used ? Address.fromBytes(fromHex(used)).toString() : '';
    const rec = el<HTMLTextAreaElement>('recipient');
    if (own && rec.value.trim() === '') rec.value = own;
    rec.disabled = false;
    el<HTMLInputElement>('qty').disabled = false;
    el<HTMLButtonElement>('refresh').disabled = false;
    await refresh();
    return 'connected — programmable balance loaded';
  }),
);
el('refresh').addEventListener('click', () => run('refresh', () => refresh().then(() => `${tokens.length} token(s)`)));
el('transfer').addEventListener('click', () => run('CIP-113 transfer', () => doTransfer(requireApi())));
el('recipient').addEventListener('input', updateRecipientPreview);

function detect(): void {
  const state = el('provider-state');
  try {
    const p = provider();
    state.textContent = `✓ ${p.name} (CIP-30 v${p.apiVersion})`;
    state.className = 'ok';
  } catch {
    state.textContent = '✗ not found — load the extension and reload';
    state.className = 'err';
  }
  const ps = el('params-state');
  if (params) {
    ps.textContent = `✓ preview deployment${params.transfer ? ' (+transfer scripts)' : ' (read-only)'}`;
  } else {
    ps.textContent = '✗ scripts/cip113-params.local.json missing — run scripts/cip113-deploy.cjs';
  }
}
setTimeout(detect, 300);
