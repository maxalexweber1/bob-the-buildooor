// Ogmios + Kupo composite provider (IMPLEMENTATION_PLAN §7, EXECUTION_PLAN T2.x/T5.3).
//
// Ogmios alone has NO address index: `queryLedgerState/utxo` scans the entire ledger UTxO set on
// every by-address call (~8 s on preview), which makes gap-limit wallet discovery (~dozens of such
// queries) blow the SW timeout. Kupo is the companion chain-indexer that answers address→UTxO in
// milliseconds. This provider routes every UTxO-by-address / -by-ref query to Kupo, and keeps Ogmios
// for what only a node can do: protocol parameters, tx submission, and Plutus `evaluateTransaction`.
import type { CanResolveToUTxO, GenesisInfos, ProtocolParameters, UTxO } from '@harmoniclabs/buildooor';
import { forceTxOutRef } from '@harmoniclabs/buildooor';
import { type ChainTip, type IChainProvider, type Network, type ScriptEvalResult } from './IChainProvider';
import { DEFAULT_TIMEOUT_MS, fetchJson } from './network';
import { type AmountUnit, toUtxo } from './mappers';
import { OgmiosProvider, type WebSocketFactory } from './ogmios';

/** One Kupo `/matches` row (v2 shape). Only the fields we map are typed. */
interface KupoMatch {
  transaction_id: string;
  output_index: number;
  address: string;
  value: { coins: number | bigint; assets?: Record<string, number | bigint> };
  datum_hash?: string | null;
  script_hash?: string | null;
}

/**
 * Kupo value → the codebase's normalized `{ unit, quantity }[]`. Kupo asset keys are
 * `policyHex.assetNameHex` (dot-separated; the name half is empty for a nameless asset) — we concat
 * to the `policyHex+assetNameHex` unit form used everywhere else (matches `ogmiosValueToUnits`).
 * NOTE: like Ogmios, Kupo encodes `coins` as a JSON number; values above 2^53 lovelace would lose
 * precision — not a concern for testnet balances, flagged for a future bigint-safe parse.
 */
export function kupoValueToUnits(value: KupoMatch['value']): AmountUnit[] {
  const out: AmountUnit[] = [{ unit: 'lovelace', quantity: value.coins.toString() }];
  for (const [key, qty] of Object.entries(value.assets ?? {})) {
    const dot = key.indexOf('.');
    const unit = dot === -1 ? key : key.slice(0, dot) + key.slice(dot + 1);
    out.push({ unit, quantity: qty.toString() });
  }
  return out;
}

export function kupoMatchToUtxo(m: KupoMatch): UTxO {
  return toUtxo({ txHash: m.transaction_id, outputIndex: m.output_index, address: m.address, amount: kupoValueToUnits(m.value) });
}

/** Minimal Kupo HTTP client — only the read endpoints the wallet needs. */
export class KupoClient {
  private readonly base: string;
  constructor(
    url: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.base = url.replace(/\/+$/, ''); // tolerate a trailing slash so `${base}/matches/…` is clean
    const proto = new URL(this.base).protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      throw new Error(`kupo: only http:// or https:// URLs allowed (got ${proto})`);
    }
  }

  /** Current unspent UTxOs at an address (indexed — milliseconds). */
  async unspentAt(address: string): Promise<UTxO[]> {
    const rows = await fetchJson<KupoMatch[]>(`${this.base}/matches/${encodeURIComponent(address)}?unspent`, {
      timeoutMs: this.timeoutMs,
      allow404: true,
    });
    return (rows ?? []).map(kupoMatchToUtxo);
  }

  /**
   * Has Kupo indexed ANY match for this address? Drives gap-limit discovery. Queried WITHOUT `unspent`,
   * so an un-pruned Kupo answers authoritatively — including addresses that were used and later emptied
   * (which Ogmios can't see). A `--prune-utxo` Kupo degrades gracefully to "currently holds a UTxO".
   */
  async hasMatch(address: string): Promise<boolean> {
    const rows = await fetchJson<KupoMatch[]>(`${this.base}/matches/${encodeURIComponent(address)}`, {
      timeoutMs: this.timeoutMs,
      allow404: true,
    });
    return (rows ?? []).length > 0;
  }

  /** Resolve a specific output ref (reference inputs / script UTxOs). Kupo pattern: `{index}@{txid}`. */
  async resolveRef(txHash: string, index: number): Promise<UTxO[]> {
    // `@` is a literal in the Kupo pattern — do NOT percent-encode it; txHash is hex, index a number.
    const rows = await fetchJson<KupoMatch[]>(`${this.base}/matches/${index}@${txHash}?unspent`, {
      timeoutMs: this.timeoutMs,
      allow404: true,
    });
    return (rows ?? []).map(kupoMatchToUtxo);
  }
}

/**
 * Composite: Kupo serves address/UTxO reads; Ogmios serves chain state, submit and script eval.
 * Deliberately does NOT implement `getUtxosForAddresses` — Kupo has no native multi-address endpoint,
 * and `collectUtxos` already fans the per-address `getUtxos` out in parallel (each is a fast indexed
 * hit), while gap-limit discovery uses the authoritative per-address `isUsed` (Kupo `hasMatch`).
 */
export class OgmiosKupoProvider implements IChainProvider {
  readonly name = 'ogmios-kupo';
  readonly network: Network;
  private readonly ogmios: OgmiosProvider;
  private readonly kupo: KupoClient;

  constructor(
    network: Network,
    ogmiosUrl: string,
    kupoUrl: string,
    opts: { timeoutMs?: number | undefined; wsFactory?: WebSocketFactory | undefined } = {},
  ) {
    this.network = network;
    this.ogmios = new OgmiosProvider(network, ogmiosUrl, opts);
    this.kupo = new KupoClient(kupoUrl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  // ---- address / utxo queries → Kupo (indexed) ----
  getUtxos(address: string): Promise<UTxO[]> {
    return this.kupo.unspentAt(address);
  }
  isUsed(address: string): Promise<boolean> {
    return this.kupo.hasMatch(address);
  }
  async resolveUtxos(refs: CanResolveToUTxO[]): Promise<UTxO[]> {
    const resolved = await Promise.all(
      refs.map((ref) => {
        const r = forceTxOutRef(ref);
        return this.kupo.resolveRef(r.id.toString(), r.index);
      }),
    );
    return resolved.flat();
  }

  // ---- chain state / submit / eval → Ogmios ----
  getGenesisInfos(): Promise<GenesisInfos> {
    return this.ogmios.getGenesisInfos();
  }
  getProtocolParameters(): Promise<ProtocolParameters> {
    return this.ogmios.getProtocolParameters();
  }
  submitTx(txCbor: string): Promise<string> {
    return this.ogmios.submitTx(txCbor);
  }
  evaluateTx(txCbor: string): Promise<ScriptEvalResult[]> {
    return this.ogmios.evaluateTx(txCbor);
  }
  getTip(): Promise<ChainTip> {
    return this.ogmios.getTip();
  }

  close(): void {
    this.ogmios.close();
  }
}
