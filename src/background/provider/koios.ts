// Koios provider (EXECUTION_PLAN T2.3) over plain `fetch`. Koios is a free, community REST layer —
// no key required (an optional bearer token raises rate limits). Endpoints/fields mirror ODATANO's
// koios-backend.ts. Most queries are POST with a JSON body; protocol params come from the
// cardano-cli-shaped /cli_protocol_params (its field names line up with buildooor's ProtocolParameters).
import { forceTxOutRef, type CanResolveToUTxO, type GenesisInfos, type ProtocolParameters, type UTxO } from '@harmoniclabs/buildooor';
import { fromHex, toArrayBuffer } from '../../core/crypto/encoding';
import { type ChainTip, type IChainProvider, type Network } from './IChainProvider';
import { DEFAULT_TIMEOUT_MS, KOIOS_BASE_URL, fetchJson, genesisInfosFor } from './network';
import { costModelsFromArrays, mergeProtocolParameters, toUtxo, type AmountUnit } from './mappers';

interface KoiosUtxoRow {
  tx_hash: string;
  tx_index: number;
  address?: string;
  value: string; // lovelace
  asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> | null;
}
interface KoiosCliParams {
  txFeePerByte: number;
  txFeeFixed: number;
  maxTxSize: number;
  maxBlockBodySize: number;
  maxBlockHeaderSize: number;
  stakeAddressDeposit: number | string;
  stakePoolDeposit: number | string;
  minPoolCost: number | string;
  utxoCostPerByte: number | string;
  maxValueSize: number | string;
  collateralPercentage: number;
  maxCollateralInputs: number;
  executionUnitPrices: { priceMemory: number; priceSteps: number };
  maxTxExecutionUnits: { memory: number; steps: number };
  maxBlockExecutionUnits: { memory: number; steps: number };
  protocolVersion: { major: number; minor: number };
  costModels?: { PlutusV1?: number[]; PlutusV2?: number[]; PlutusV3?: number[] } | null;
}

function rowToRaw(row: KoiosUtxoRow, fallbackAddress: string): { txHash: string; outputIndex: number; address: string; amount: AmountUnit[] } {
  const amount: AmountUnit[] = [{ unit: 'lovelace', quantity: row.value }];
  for (const a of row.asset_list ?? []) {
    amount.push({ unit: `${a.policy_id}${a.asset_name}`, quantity: a.quantity });
  }
  return { txHash: row.tx_hash, outputIndex: row.tx_index, address: row.address ?? fallbackAddress, amount };
}

export class KoiosProvider implements IChainProvider {
  readonly name = 'koios';
  readonly network: Network;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly authHeader: Record<string, string>;

  constructor(network: Network, opts: { apiKey?: string | undefined; timeoutMs?: number | undefined } = {}) {
    this.network = network;
    this.base = KOIOS_BASE_URL[network];
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authHeader = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
  }

  private post<T>(path: string, body: unknown): Promise<T | null> {
    return fetchJson<T>(`${this.base}${path}`, {
      method: 'POST',
      headers: { ...this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    });
  }
  private get<T>(path: string): Promise<T | null> {
    return fetchJson<T>(`${this.base}${path}`, { headers: this.authHeader, timeoutMs: this.timeoutMs });
  }

  getGenesisInfos(): Promise<GenesisInfos> {
    return Promise.resolve(genesisInfosFor(this.network));
  }

  async getUtxos(address: string): Promise<UTxO[]> {
    const rows = (await this.post<KoiosUtxoRow[]>('/address_utxos', { _addresses: [address], _extended: true })) ?? [];
    return rows.map((r) => toUtxo(rowToRaw(r, address)));
  }

  /** Used iff the address has any tx history. /address_txs is authoritative (historic). */
  async isUsed(address: string): Promise<boolean> {
    const rows = (await this.post<unknown[]>('/address_txs', { _addresses: [address] })) ?? [];
    return rows.length > 0;
  }

  async resolveUtxos(refs: CanResolveToUTxO[]): Promise<UTxO[]> {
    const utxoRefs = refs.map((ref) => {
      const r = forceTxOutRef(ref);
      return `${r.id.toString()}#${r.index}`;
    });
    const rows = (await this.post<KoiosUtxoRow[]>('/utxo_info', { _utxo_refs: utxoRefs, _extended: true })) ?? [];
    return rows.map((r) => toUtxo(rowToRaw(r, r.address ?? '')));
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const p = await this.get<KoiosCliParams>('/cli_protocol_params');
    if (!p) throw new Error('koios: missing protocol parameters');
    return mergeProtocolParameters({
      txFeePerByte: p.txFeePerByte,
      txFeeFixed: p.txFeeFixed,
      maxTxSize: p.maxTxSize,
      maxBlockBodySize: p.maxBlockBodySize,
      maxBlockHeaderSize: p.maxBlockHeaderSize,
      stakeAddressDeposit: BigInt(p.stakeAddressDeposit),
      stakePoolDeposit: BigInt(p.stakePoolDeposit),
      minPoolCost: BigInt(p.minPoolCost),
      utxoCostPerByte: BigInt(p.utxoCostPerByte),
      maxValueSize: BigInt(p.maxValueSize),
      collateralPercentage: p.collateralPercentage,
      maxCollateralInputs: p.maxCollateralInputs,
      executionUnitPrices: p.executionUnitPrices,
      maxTxExecutionUnits: p.maxTxExecutionUnits,
      maxBlockExecutionUnits: p.maxBlockExecutionUnits,
      protocolVersion: p.protocolVersion,
      // Real Plutus cost models — required for a correct scriptDataHash.
      ...(p.costModels
        ? { costModels: costModelsFromArrays({ v1: p.costModels.PlutusV1, v2: p.costModels.PlutusV2, v3: p.costModels.PlutusV3 }) }
        : {}),
    });
  }

  /** POST raw CBOR bytes to /submittx. Returns the tx hash (Koios may quote it). */
  async submitTx(txCbor: string): Promise<string> {
    const hash = await fetchJson<string>(`${this.base}/submittx`, {
      method: 'POST',
      headers: { ...this.authHeader, 'Content-Type': 'application/cbor' },
      body: toArrayBuffer(fromHex(txCbor)),
      timeoutMs: this.timeoutMs,
    });
    if (!hash) throw new Error('koios: empty submit response');
    return hash.trim().replace(/^"|"$/g, '');
  }

  async getTip(): Promise<ChainTip> {
    const tip = await this.get<Array<{ hash: string; abs_slot: number; block_no: number }>>('/tip');
    const row = tip?.[0];
    if (!row) throw new Error('koios: empty /tip');
    return { slot: row.abs_slot, hash: row.hash, height: row.block_no };
  }

  /** Confirmed once /tx_status reports any confirmations. */
  async isConfirmed(txHash: string): Promise<boolean> {
    const rows = (await this.post<Array<{ num_confirmations: number | null }>>('/tx_status', { _tx_hashes: [txHash] })) ?? [];
    return (rows[0]?.num_confirmations ?? 0) > 0;
  }

  // No evaluateTx — Koios has no ledger-state script eval; use Ogmios for Plutus ex-units (M5).
}
