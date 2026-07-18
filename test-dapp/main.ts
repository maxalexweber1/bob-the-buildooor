// CIP-30 test dApp (dev tool for T4.x / M5 / M9). Loaded in a normal browser tab with the extension
// installed: it talks to `window.cardano.bob` like any dApp, but for the write flows it BUILDS real
// transactions in-page with buildooor (the wallet only returns a witness set — a dApp must build its
// own tx), gets them signed via the wallet's approval popup, and submits. Reuses the wallet's own
// pure builders so the harness stays small and the flows match production.
//
// Not shipped in the extension — served standalone via `npm run dev:dapp` (vite.dapp.config.ts).
import {
  Address,
  Application,
  Lambda,
  Script,
  Tx,
  TxBuilder,
  TxWitnessSet,
  UPLCConst,
  UPLCProgram,
  UTxO,
  compileUPLC,
  DataConstr,
} from '@harmoniclabs/buildooor';
import { buildSend } from '../src/core/tx/build';
import { buildPlutusMint } from '../src/core/tx/plutusBuild';
import { BlockfrostProvider } from '../src/background/provider/blockfrost';
import { fromHex, toHex } from '../src/core/crypto/encoding';
import { submitWithDiagnostics } from './submitDiag';

const WALLET_KEY = 'bob';
const TOKEN_NAME = 'TESTDAPP';
const TOKEN_NAME_HEX = toHex(new TextEncoder().encode(TOKEN_NAME));

// One always-succeeds Plutus V3 policy, stable across mint+burn so they share a policy id. Distinct
// body (application to a constant) keeps it off any other fixture's hash; returns unit (V3 requires it).
const mintPolicy = Script.plutusV3(
  compileUPLC(new UPLCProgram([1, 1, 0], new Lambda(new Application(new Lambda(UPLCConst.unit), UPLCConst.int(42))))),
);

// ---- CIP-30 provider + chain data ----------------------------------------------------------------
interface Cip30Api {
  getNetworkId(): Promise<number>;
  getBalance(): Promise<string>;
  getUtxos(amount?: string): Promise<string[] | null>;
  getCollateral(params?: { amount?: string }): Promise<string[]>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  getRewardAddresses(): Promise<string[]>;
  getExtensions(): Promise<unknown>;
  signTx(tx: string, partialSign?: boolean): Promise<string>;
  signData(addr: string, payload: string): Promise<{ signature: string; key: string }>;
  submitTx(tx: string): Promise<string>;
}
interface Cip30Provider {
  apiVersion: string;
  name: string;
  isEnabled(): Promise<boolean>;
  enable(opts?: { extensions?: { cip: number }[] }): Promise<Cip30Api>;
}

let api: Cip30Api | null = null;
const provider = () => {
  const p = (window as unknown as { cardano?: Record<string, Cip30Provider> }).cardano?.[WALLET_KEY];
  if (!p) throw new Error('window.cardano.bob not found — is the extension loaded on this page?');
  return p;
};
const requireApi = () => {
  if (!api) throw new Error('call enable() first');
  return api;
};

// Preview chain data (protocol params incl. cost models + genesis) for in-page tx building. Uses
// Blockfrost because it's CORS-open (Access-Control-Allow-Origin: *) — Koios preview omits that
// header, so a page-origin fetch is blocked. Same VITE key the extension uses (.env at repo root).
// A real dApp uses its own provider/backend; a CIP-30 wallet does NOT expose protocol parameters.
// Submit still goes through the wallet.
const BF_KEY = import.meta.env.VITE_BLOCKFROST_PROJECT_ID_PREVIEW as string | undefined;
if (!BF_KEY) {
  document.addEventListener('DOMContentLoaded', () => {
    const s = document.getElementById('provider-state');
    if (s) s.textContent = '⚠ set VITE_BLOCKFROST_PROJECT_ID_PREVIEW in .env for tx building';
  });
}
const chain = new BlockfrostProvider('preview', BF_KEY ?? '');

// Protocol parameters change once per epoch at most — fetch them once per page load, not on every
// build. This shaves a page-side Blockfrost round trip off every Send/Mint/Burn before the wallet's
// signTx popup can even be requested. (Genesis infos are local constants — no fetch to cache.)
// A failed fetch is NOT cached (the rejected promise is dropped) so a transient error can be retried.
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
// Prefetch at page load so even the FIRST build skips the round trip.
if (BF_KEY) void protocolParams().catch(() => undefined);

async function walletUtxos(a: Cip30Api): Promise<UTxO[]> {
  const hexes = (await a.getUtxos()) ?? [];
  return hexes.map((h) => UTxO.fromCbor(h));
}
async function walletCollateral(a: Cip30Api): Promise<UTxO> {
  // 2 ADA is ample: collateral must cover ~150% of the fee (≈0.3 ADA for these txs). Requesting the
  // CIP-30-customary 5 ADA fails outright on wallets whose ADA-only UTxOs sum below that, even
  // though a single 2 ADA UTxO is a perfectly good collateral.
  const [first] = await a.getCollateral({ amount: '2000000' });
  if (!first) throw new Error('no collateral — the wallet has no ADA-only UTxO (send yourself ~2 ADA first)');
  return UTxO.fromCbor(first);
}
async function changeAddr(a: Cip30Api): Promise<string> {
  return Address.fromBytes(fromHex(await a.getChangeAddress())).toString();
}

/** Sign (witness set only) → merge into the built tx → submit via the wallet. Returns the tx hash.
 *  On rejection, submitWithDiagnostics surfaces the node's REAL verdict in the log (dev harness). */
async function signAndSubmit(a: Cip30Api, tx: Tx): Promise<string> {
  log('   tx built — requesting signature (wallet popup)…', 'dim');
  const wsHex = await a.signTx(toHex(tx.toCborBytes()), true);
  log('   signed — submitting…', 'dim');
  const ws = TxWitnessSet.fromCbor(wsHex);
  for (const vk of ws.vkeyWitnesses ?? []) tx.addVKeyWitness(vk);
  return submitWithDiagnostics(BF_KEY, a, toHex(tx.toCborBytes()), log);
}

// ---- write flows ---------------------------------------------------------------------------------
async function doSend(a: Cip30Api): Promise<string> {
  // The wallet reads and the chain-data fetches are independent — overlap them instead of paying
  // their latencies in sequence, so signTx (and its popup) is reached as early as possible.
  const [change, protocolParameters, genesisInfos, utxos] = await Promise.all([
    changeAddr(a),
    protocolParams(),
    chain.getGenesisInfos(),
    walletUtxos(a),
  ]);
  const tx = buildSend(
    { protocolParameters, genesisInfos, utxos, changeAddress: change },
    { toAddress: change, lovelace: 2_000_000n }, // to self — no second wallet needed
  );
  return signAndSubmit(a, tx);
}

async function doMint(a: Cip30Api): Promise<string> {
  const [change, utxos, collateral, protocolParameters, genesisInfos] = await Promise.all([
    changeAddr(a),
    walletUtxos(a),
    walletCollateral(a),
    protocolParams(),
    chain.getGenesisInfos(),
  ]);
  const funding = utxos.filter((u) => u.utxoRef.toString() !== collateral.utxoRef.toString());
  const tx = buildPlutusMint({
    protocolParameters,
    genesisInfos,
    policy: mintPolicy,
    redeemer: new DataConstr(0, []),
    mint: [{ nameHex: TOKEN_NAME_HEX, quantity: 100n }],
    toAddress: change,
    collateral,
    fundingUtxos: funding,
    changeAddress: change,
  });
  return signAndSubmit(a, tx);
}

async function doBurn(a: Cip30Api): Promise<string> {
  const [change, utxos, collateral, pp, gi] = await Promise.all([
    changeAddr(a),
    walletUtxos(a),
    walletCollateral(a),
    protocolParams(),
    chain.getGenesisInfos(),
  ]);
  const unit = mintPolicy.hash.toString() + TOKEN_NAME_HEX;
  const held = utxos.reduce((s, u) => {
    const j = u.resolved.value.toJson() as Record<string, Record<string, string>>;
    return s + BigInt(j[mintPolicy.hash.toString()]?.[TOKEN_NAME_HEX] ?? '0');
  }, 0n);
  if (held < 50n) throw new Error(`need ≥50 ${TOKEN_NAME} to burn (hold ${held}) — mint first`);
  const funding = utxos.filter((u) => u.utxoRef.toString() !== collateral.utxoRef.toString());

  // Burn = negative mint with NO token output; the wallet's mint builder always emits an output, so
  // burn is built inline here (TxBuilder directly). Change carries the surviving tokens/ADA back.
  const tb = new TxBuilder(pp, gi);
  const tx = tb.buildSync({
    inputs: funding.map((utxo) => ({ utxo })),
    mints: [
      {
        value: { policy: mintPolicy.hash, assets: [{ name: TOKEN_NAME_HEX, quantity: -50n }] },
        script: { inline: mintPolicy, redeemer: new DataConstr(0, []) },
      },
    ],
    collaterals: [collateral],
    changeAddress: change,
  });
  void unit;
  return signAndSubmit(a, tx);
}

// ---- UI wiring -----------------------------------------------------------------------------------
function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} missing`);
  return found as T;
}
const logEl = el<HTMLDivElement>('log');
function log(msg: string, cls = ''): void {
  const t = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${t}  ${msg}`;
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
}

el('connect').addEventListener('click', () =>
  run('enable()', async () => {
    api = await provider().enable({ extensions: [{ cip: 95 }] });
    // Warm the wallet's address-discovery cache in the background: the first Send/Mint/Burn then
    // finds its wallet reads (getUtxos/getChangeAddress) already answered, and the signTx popup
    // appears near-instantly instead of after a cold gap-limit scan.
    void api.getChangeAddress().catch(() => undefined);
    return 'API granted';
  }),
);

const READS: Record<string, (a: Cip30Api) => Promise<unknown>> = {
  getNetworkId: (a) => a.getNetworkId(),
  getBalance: (a) => a.getBalance(),
  getUtxos: async (a) => `${((await a.getUtxos()) ?? []).length} utxo(s)`,
  getCollateral: async (a) => `${(await a.getCollateral({ amount: '5000000' })).length} utxo(s)`,
  getChangeAddress: (a) => changeAddr(a),
  getUsedAddresses: async (a) => `${(await a.getUsedAddresses()).length} address(es)`,
  getRewardAddresses: (a) => a.getRewardAddresses(),
  getExtensions: (a) => a.getExtensions(),
};
document.querySelectorAll<HTMLButtonElement>('button[data-read]').forEach((btn) => {
  const name = btn.dataset.read;
  const fn = name ? READS[name] : undefined;
  if (!name || !fn) return;
  btn.addEventListener('click', () => run(name, () => fn(requireApi())));
});

el('sign-data').addEventListener('click', () =>
  run('signData', async () => {
    const a = requireApi();
    const [addr] = await a.getUsedAddresses();
    const target = addr ?? (await a.getChangeAddress());
    const payload = toHex(new TextEncoder().encode('Sign-in to bob test dApp'));
    const sig = await a.signData(target, payload);
    return `sig=${sig.signature.slice(0, 20)}… key=${sig.key.slice(0, 20)}…`;
  }),
);
el('send').addEventListener('click', () => run('Send 2 ₳ → self', () => doSend(requireApi())));
el('mint').addEventListener('click', () => run(`Mint 100 ${TOKEN_NAME}`, () => doMint(requireApi())));
el('burn').addEventListener('click', () => run(`Burn 50 ${TOKEN_NAME}`, () => doBurn(requireApi())));

// The content script injects at document_start; the provider lands a tick later.
setTimeout(detect, 300);
