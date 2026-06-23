// Blockfrost provider (EXECUTION_PLAN T2.2) over plain `fetch` (no @blockfrost/blockfrost-js — it's
// node-oriented and would bloat the SW). Field mappings mirror ODATANO's blockfrost-backend.ts.
import { forceTxOutRef, type CanResolveToUTxO, type GenesisInfos, type ProtocolParameters, type UTxO } from '@harmoniclabs/buildooor';
import { fromHex, toArrayBuffer } from '../../core/crypto/encoding';
import { type ChainTip, type IChainProvider, type Network } from './IChainProvider';
import { BLOCKFROST_BASE_URL, DEFAULT_TIMEOUT_MS, fetchJson, genesisInfosFor } from './network';
import { mergeProtocolParameters, toUtxo, type AmountUnit } from './mappers';

interface BfUtxo {
  tx_hash: string;
  output_index: number;
  address?: string;
  amount: AmountUnit[];
  data_hash?: string | null;
  inline_datum?: string | null;
  reference_script_hash?: string | null;
}
interface BfTxUtxos {
  outputs: Array<{
    address: string;
    amount: AmountUnit[];
    output_index: number;
    data_hash?: string | null;
    inline_datum?: string | null;
    reference_script_hash?: string | null;
  }>;
}
interface BfParams {
  min_fee_a: number;
  min_fee_b: number;
  max_tx_size: number;
  max_block_size: number;
  max_block_header_size: number;
  key_deposit: string;
  pool_deposit: string;
  min_pool_cost: string;
  coins_per_utxo_size: string;
  max_val_size: string;
  collateral_percent: number;
  max_collateral_inputs: number;
  price_mem: number;
  price_step: number;
  max_tx_ex_mem: string;
  max_tx_ex_steps: string;
  max_block_ex_mem: string;
  max_block_ex_steps: string;
  protocol_major_ver: number;
  protocol_minor_ver: number;
}

export class BlockfrostProvider implements IChainProvider {
  readonly name = 'blockfrost';
  readonly network: Network;
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(network: Network, projectId: string, opts: { timeoutMs?: number | undefined } = {}) {
    if (!projectId) throw new Error('blockfrost: projectId is required');
    this.network = network;
    this.base = BLOCKFROST_BASE_URL[network];
    this.headers = { project_id: projectId };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get<T>(path: string, allow404 = false): Promise<T | null> {
    return fetchJson<T>(`${this.base}${path}`, { headers: this.headers, timeoutMs: this.timeoutMs, allow404 });
  }

  getGenesisInfos(): Promise<GenesisInfos> {
    return Promise.resolve(genesisInfosFor(this.network));
  }

  /** All UTxOs at an address. Blockfrost paginates at 100/page; 404 = unused address → []. */
  async getUtxos(address: string): Promise<UTxO[]> {
    const out: UTxO[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.get<BfUtxo[]>(`/addresses/${address}/utxos?count=100&page=${page}`, true);
      if (!rows || rows.length === 0) break;
      for (const u of rows) {
        out.push(toUtxo({ txHash: u.tx_hash, outputIndex: u.output_index, address: u.address ?? address, amount: u.amount }));
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  /** Used iff /addresses/{addr} exists (200). Blockfrost returns 404 for an address never seen on-chain. */
  async isUsed(address: string): Promise<boolean> {
    const info = await this.get<{ tx_count?: number }>(`/addresses/${address}`, true);
    return info !== null;
  }

  /** Resolve specific output refs → UTxOs (reference/script inputs). Groups by tx to minimize calls. */
  async resolveUtxos(refs: CanResolveToUTxO[]): Promise<UTxO[]> {
    const byTx = new Map<string, number[]>();
    for (const ref of refs) {
      const r = forceTxOutRef(ref);
      const id = r.id.toString();
      const list = byTx.get(id) ?? [];
      list.push(r.index);
      byTx.set(id, list);
    }
    const out: UTxO[] = [];
    for (const [txHash, indices] of byTx) {
      const data = await this.get<BfTxUtxos>(`/txs/${txHash}/utxos`, true);
      if (!data) continue;
      for (const idx of indices) {
        const o = data.outputs.find((x) => x.output_index === idx);
        if (o) out.push(toUtxo({ txHash, outputIndex: idx, address: o.address, amount: o.amount }));
      }
    }
    return out;
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const p = await this.get<BfParams>('/epochs/latest/parameters');
    if (!p) throw new Error('blockfrost: missing protocol parameters');
    return mergeProtocolParameters({
      txFeePerByte: p.min_fee_a,
      txFeeFixed: p.min_fee_b,
      maxTxSize: p.max_tx_size,
      maxBlockBodySize: p.max_block_size,
      maxBlockHeaderSize: p.max_block_header_size,
      stakeAddressDeposit: BigInt(p.key_deposit),
      stakePoolDeposit: BigInt(p.pool_deposit),
      minPoolCost: BigInt(p.min_pool_cost),
      utxoCostPerByte: BigInt(p.coins_per_utxo_size),
      maxValueSize: BigInt(p.max_val_size),
      collateralPercentage: p.collateral_percent,
      maxCollateralInputs: p.max_collateral_inputs,
      executionUnitPrices: { priceMemory: p.price_mem, priceSteps: p.price_step },
      maxTxExecutionUnits: { memory: Number(p.max_tx_ex_mem), steps: Number(p.max_tx_ex_steps) },
      maxBlockExecutionUnits: { memory: Number(p.max_block_ex_mem), steps: Number(p.max_block_ex_steps) },
      protocolVersion: { major: p.protocol_major_ver, minor: p.protocol_minor_ver },
    });
  }

  /** POST the raw CBOR bytes to /tx/submit. Returns the tx hash. */
  async submitTx(txCbor: string): Promise<string> {
    const hash = await fetchJson<string>(`${this.base}/tx/submit`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/cbor' },
      body: toArrayBuffer(fromHex(txCbor)),
      timeoutMs: this.timeoutMs,
    });
    if (!hash) throw new Error('blockfrost: empty submit response');
    return hash;
  }

  async getTip(): Promise<ChainTip> {
    const b = await this.get<{ slot: number; hash: string; height: number }>('/blocks/latest');
    if (!b) throw new Error('blockfrost: missing latest block');
    return { slot: b.slot, hash: b.hash, height: b.height };
  }

  /** Confirmed once /txs/{hash} exists (404 = not yet on-chain). */
  async isConfirmed(txHash: string): Promise<boolean> {
    return (await this.get<{ hash: string }>(`/txs/${txHash}`, true)) !== null;
  }

  // NOTE: no `evaluateTx` — Blockfrost-REST has no authoritative ledger-state eval. Callers detect
  // this by absence (`if (provider.evaluateTx)`); use Ogmios for Plutus ex-units (M5).
}
