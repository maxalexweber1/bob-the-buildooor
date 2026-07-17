// Blockfrost provider (EXECUTION_PLAN T2.2) over plain `fetch` (no @blockfrost/blockfrost-js — it's
// node-oriented and would bloat the SW). Field mappings mirror ODATANO's blockfrost-backend.ts.
import { forceTxOutRef, type CanResolveToUTxO, type GenesisInfos, type ProtocolParameters, type UTxO } from '@harmoniclabs/buildooor';
import { fromHex, toArrayBuffer } from '../../core/crypto/encoding';
import { type AddressTxRef, type AssetMetadata, type ChainTip, type IChainProvider, type Network, type TxIODetail } from './IChainProvider';
import { BLOCKFROST_BASE_URL, DEFAULT_TIMEOUT_MS, fetchJson, genesisInfosFor } from './network';
import { costModelsFromArrays, mergeProtocolParameters, toUtxo, pickString, pickNumber, joinImageUri, type AmountUnit } from './mappers';

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
  cost_models_raw?: { PlutusV1?: number[]; PlutusV2?: number[]; PlutusV3?: number[] } | null;
}
interface BfAsset {
  /** CIP-25/68 on-chain metadata — freeform; we pick known display keys defensively. */
  onchain_metadata?: Record<string, unknown> | null;
  onchain_metadata_standard?: string | null;
  /** Off-chain CIP-26 token registry (mostly fungible tokens). */
  metadata?: Record<string, unknown> | null;
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
        out.push(
          toUtxo({
            txHash: u.tx_hash,
            outputIndex: u.output_index,
            address: u.address ?? address,
            amount: u.amount,
            datumHash: u.data_hash,
            inlineDatum: u.inline_datum,
          }),
        );
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
        if (o) {
          out.push(
            toUtxo({
              txHash,
              outputIndex: idx,
              address: o.address,
              amount: o.amount,
              datumHash: o.data_hash,
              inlineDatum: o.inline_datum,
            }),
          );
        }
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
      // Real Plutus cost models — required for a correct scriptDataHash.
      ...(p.cost_models_raw
        ? { costModels: costModelsFromArrays({ v1: p.cost_models_raw.PlutusV1, v2: p.cost_models_raw.PlutusV2, v3: p.cost_models_raw.PlutusV3 }) }
        : {}),
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

  /** CIP-95 stake-key registration state: /accounts/{stake} `active` (deregistration clears it). 404 → never seen → false. */
  async getStakeRegistration(stakeAddress: string): Promise<boolean> {
    const a = await this.get<{ active: boolean }>(`/accounts/${stakeAddress}`, true);
    return a?.active === true;
  }

  /** Display metadata for an asset (CIP-25 on-chain, falling back to the off-chain registry). 404 → null. */
  async getAssetMetadata(unit: string): Promise<AssetMetadata | null> {
    const a = await this.get<BfAsset>(`/assets/${unit}`, true);
    if (!a) return null;
    const on = a.onchain_metadata ?? undefined;
    const off = a.metadata ?? undefined;
    const md: AssetMetadata = {};
    const name = pickString(on?.name) ?? pickString(off?.name);
    const description = pickString(on?.description) ?? pickString(off?.description);
    const image = joinImageUri(on?.image) ?? joinImageUri(off?.logo);
    const decimals = pickNumber(off?.decimals);
    const standard = pickString(a.onchain_metadata_standard);
    if (name !== undefined) md.name = name;
    if (description !== undefined) md.description = description;
    if (image !== undefined) md.image = image;
    if (decimals !== undefined) md.decimals = decimals;
    if (standard !== undefined) md.standard = standard;
    return Object.keys(md).length > 0 ? md : null;
  }

  /** Addresses holding an asset (NFT holder lookup for ADA Handle resolution, T8.1). 404 → []. */
  async getAssetAddresses(unit: string): Promise<{ address: string; quantity: string }[]> {
    if (!/^[0-9a-f]{56,120}$/i.test(unit)) return [];
    const rows = await this.get<Array<{ address: string; quantity: string }>>(
      `/assets/${unit}/addresses?count=100&page=1`,
      true,
    );
    return rows ?? [];
  }

  /** Recent transactions at an address, newest first (20/page). 404 (unused address) → []. */
  async getAddressTransactions(address: string, page = 1): Promise<AddressTxRef[]> {
    const rows = await this.get<Array<{ tx_hash: string; block_height: number; block_time: number }>>(
      `/addresses/${address}/transactions?order=desc&count=20&page=${page}`,
      true,
    );
    if (!rows) return [];
    return rows.map((r) => ({ txHash: r.tx_hash, blockTime: r.block_time, blockHeight: r.block_height }));
  }

  /** Full tx IO for net-delta. Excludes collateral/reference inputs (not value the tx actually spends). */
  async getTxDetail(txHash: string): Promise<TxIODetail> {
    const data = await this.get<{
      inputs: Array<{ address: string; amount: AmountUnit[]; collateral?: boolean; reference?: boolean }>;
      outputs: Array<{ address: string; amount: AmountUnit[] }>;
    }>(`/txs/${txHash}/utxos`);
    if (!data) throw new Error(`blockfrost: tx ${txHash} utxos not found`);
    const meta = await this.get<{ fees?: string }>(`/txs/${txHash}`, true);
    const party = (p: { address: string; amount: AmountUnit[] }) => ({
      address: p.address,
      amount: p.amount.map((a) => ({ unit: a.unit, quantity: a.quantity })),
    });
    return {
      txHash,
      inputs: data.inputs.filter((i) => !i.collateral && !i.reference).map(party),
      outputs: data.outputs.map(party),
      ...(meta?.fees ? { fee: meta.fees } : {}),
    };
  }

  // NOTE: no `evaluateTx` — Blockfrost-REST has no authoritative ledger-state eval. Callers detect
  // this by absence (`if (provider.evaluateTx)`); use Ogmios for Plutus ex-units (M5).
}
