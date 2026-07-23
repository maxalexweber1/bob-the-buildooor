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
  /** Present only when `enable({extensions:[{cip:103}]})` granted the bulk-signing extension. */
  cip103?: {
    signTxs(txs: { cbor: string; partialSign?: boolean }[]): Promise<string[]>;
    submitTxs(txs: string[]): Promise<Array<string | { code: number; info: string }>>;
  };
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

// ---- CIP-103 bulk signing ------------------------------------------------------------------------
function requireBulk(a: Cip30Api) {
  if (!a.cip103) throw new Error('cip103 not granted — enable({extensions:[{cip:103}]}) first');
  return a.cip103;
}
/** Apply a witness set returned by the wallet to the tx it belongs to. */
function applyWitnesses(tx: Tx, witnessSetHex: string): Tx {
  for (const vk of TxWitnessSet.fromCbor(witnessSetHex).vkeyWitnesses ?? []) tx.addVKeyWitness(vk);
  return tx;
}
const fmtAda = (lovelace: bigint) => `${(Number(lovelace) / 1e6).toFixed(2)} ₳`;

/**
 * A wallet-owned output of `tx` big enough to fund the NEXT tx in the chain — spendable before `tx` is
 * even submitted. Requires a minimum: our coin selection needs `amount + 2 ₳ buffer + 0.1 ₳/input`
 * (`core/tx/coinSelect.ts`), and when tx#1 pays itself, its payment AND its change output sit on the
 * same address — picking "the first output at my address" can hand back one that is too small to spend.
 */
function chainableOutput(tx: Tx, owner: string, minLovelace: bigint): UTxO {
  const index = tx.body.outputs.findIndex(
    (o) => o.address.toString() === owner && o.value.lovelaces >= minLovelace,
  );
  const resolved = tx.body.outputs[index];
  if (!resolved) {
    const own = tx.body.outputs.filter((o) => o.address.toString() === owner).map((o) => fmtAda(o.value.lovelaces));
    throw new Error(`tx#1 has no own output ≥ ${fmtAda(minLovelace)} to chain from (has: ${own.join(', ') || 'none'})`);
  }
  return new UTxO({ utxoRef: { id: tx.body.hash.toString(), index }, resolved });
}

/** Label a build failure with the tx it came from — "insufficient funds" alone says nothing in a batch. */
function build(label: string, fn: () => Tx): Tx {
  try {
    return fn();
  } catch (e) {
    throw new Error(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Total spendable lovelace, for an up-front "you need N ₳" check instead of a build failure. */
function totalLovelace(utxos: UTxO[]): bigint {
  return utxos.reduce((sum, u) => sum + u.resolved.value.lovelaces, 0n);
}

/** tx#2 spends tx#1's change output — the canonical CIP-103 chain: one approval, ordered submit. */
async function doBulkChained(a: Cip30Api): Promise<string> {
  const bulk = requireBulk(a);
  const [change, protocolParameters, genesisInfos, utxos] = await Promise.all([
    changeAddr(a),
    protocolParams(),
    chain.getGenesisInfos(),
    walletUtxos(a),
  ]);
  // tx#1 pays 5 ₳ to itself; tx#2 spends exactly that output. 5 ₳ is not arbitrary: tx#2 sends 1 ₳ and
  // coin selection wants amount + 2 ₳ buffer + 0.1 ₳/input on TOP, so the chained output must exceed
  // ~3.1 ₳ to be spendable at all.
  const CHAIN_HEAD = 5_000_000n;
  const CHAIN_TAIL = 1_000_000n;
  const MIN_CHAINABLE = CHAIN_TAIL + 2_100_000n;
  const need = CHAIN_HEAD + 2_100_000n;
  const have = totalLovelace(utxos);
  if (have < need) {
    throw new Error(`needs ~${fmtAda(need)} — wallet holds ${fmtAda(have)} across ${utxos.length} utxo(s)`);
  }

  const ctx = { protocolParameters, genesisInfos, changeAddress: change };
  const tx1 = build('tx#1', () => buildSend({ ...ctx, utxos }, { toAddress: change, lovelace: CHAIN_HEAD }));
  const chained = chainableOutput(tx1, change, MIN_CHAINABLE);
  const tx2 = build('tx#2', () =>
    buildSend({ ...ctx, utxos: [chained] }, { toAddress: change, lovelace: CHAIN_TAIL }),
  );
  log(`   tx#2 chains off ${chained.utxoRef.toString().slice(0, 12)}…#${chained.utxoRef.index} (${fmtAda(chained.resolved.value.lovelaces)})`, 'dim');

  log('   2 chained txs built — requesting ONE bulk approval (wallet popup)…', 'dim');
  const [w1, w2] = await bulk.signTxs([{ cbor: toHex(tx1.toCborBytes()) }, { cbor: toHex(tx2.toCborBytes()) }]);
  if (!w1 || !w2) throw new Error('expected one witness set per transaction');
  const signed = [applyWitnesses(tx1, w1), applyWitnesses(tx2, w2)];

  log('   signed — submitting both in order…', 'dim');
  const results = await bulk.submitTxs(signed.map((t) => toHex(t.toCborBytes())));
  // Log each result on its OWN line with the FULL hash + explorer link: a truncated hash can't be
  // looked up, and the whole point of a chained batch is checking both txs actually landed.
  let ok = 0;
  results.forEach((r, i) => {
    if (typeof r === 'string') {
      ok++;
      log(`   #${i + 1} ${r}`, 'ok');
      log(`      https://preview.cardanoscan.io/transaction/${r}`, 'dim');
    } else {
      log(`   #${i + 1} ✗ [${r.code}] ${r.info}`, 'err');
    }
  });
  return `${ok}/${results.length} submitted in order`;
}

/** Two competing spends of the SAME UTxO. Legal to sign in one batch; only one could ever settle —
 *  so this demo stops at the signature (submitting both would just have the node reject the loser). */
async function doBulkSameInput(a: Cip30Api): Promise<string> {
  const bulk = requireBulk(a);
  const [change, protocolParameters, genesisInfos, utxos] = await Promise.all([
    changeAddr(a),
    protocolParams(),
    chain.getGenesisInfos(),
    walletUtxos(a),
  ]);
  // Largest UTxO, not utxos[0]: both txs must be fundable from that ONE input (that's the point —
  // they compete for it), and coin selection needs the amount + ~2.1 ₳ on top.
  const [biggest] = [...utxos].sort((x, y) => (y.resolved.value.lovelaces > x.resolved.value.lovelaces ? 1 : -1));
  if (!biggest) throw new Error('wallet has no UTxO');
  if (biggest.resolved.value.lovelaces < 3_600_000n) {
    throw new Error(`largest utxo is ${fmtAda(biggest.resolved.value.lovelaces)}, needs ≥ 3.60 ₳ to fund both spends`);
  }
  const ctx = { protocolParameters, genesisInfos, changeAddress: change, utxos: [biggest] };
  const a1 = build('tx#1', () => buildSend(ctx, { toAddress: change, lovelace: 1_000_000n }));
  const a2 = build('tx#2', () => buildSend(ctx, { toAddress: change, lovelace: 1_500_000n })); // same input

  log('   2 competing txs on one UTxO — the popup should flag the conflict…', 'dim');
  const witnesses = await bulk.signTxs([{ cbor: toHex(a1.toCborBytes()) }, { cbor: toHex(a2.toCborBytes()) }]);
  return `${witnesses.length} witness set(s) — not submitted (would be a double spend)`;
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
    // CIP-30 errors cross the bridge as `{code, info}` (PaginateError as `{maxSize}`) — surface the
    // CODE, not just the text: it is what distinguishes "user declined" (TxSignError 2) from "origin
    // refused" (-3) or "extension not negotiated" (-1), which read almost the same in prose.
    const err = e as { code?: number; info?: string; maxSize?: number };
    const info = err.info ?? (e as Error).message ?? JSON.stringify(e);
    const code = err.code !== undefined ? `[${err.code}] ` : err.maxSize !== undefined ? `[maxSize=${err.maxSize}] ` : '';
    log(`✗ ${label} (${ms()}): ${code}${info}`, 'err');
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
    api = await provider().enable({ extensions: [{ cip: 95 }, { cip: 103 }] });
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
el('bulk-chained').addEventListener('click', () =>
  run('cip103 chained sign+submit', () => doBulkChained(requireApi())),
);
el('bulk-conflict').addEventListener('click', () =>
  run('cip103 same-input sign', () => doBulkSameInput(requireApi())),
);

// The content script injects at document_start; the provider lands a tick later.
setTimeout(detect, 300);
