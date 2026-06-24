// Ogmios provider (EXECUTION_PLAN T2.3) — talks to a local/remote Cardano node's Ogmios bridge over
// a WebSocket using JSON-RPC 2.0 directly. We DON'T use @cardano-ogmios/client (node-oriented: pulls
// `ws`, EventEmitter, etc.) — native WebSocket exists in the SW and keeps the bundle/CSP clean.
//
// This is also the stepping stone to a local full node: point `ogmiosUrl` at `ws://localhost:1337`
// for a local cardano-node+Ogmios today, and a future GerolamoProvider slots in behind IChainProvider
// the same way (see IChainProvider.ts).
import type { CanResolveToUTxO, GenesisInfos, ProtocolParameters, UTxO } from '@harmoniclabs/buildooor';
import { forceTxOutRef } from '@harmoniclabs/buildooor';
import {
  ProviderError,
  ProviderTimeoutError,
  type ChainTip,
  type IChainProvider,
  type Network,
  type ScriptEvalResult,
} from './IChainProvider';
import { DEFAULT_TIMEOUT_MS, genesisInfosFor } from './network';
import { costModelsFromArrays, mergeProtocolParameters, ogmiosValueToUnits, parseRatio, toUtxo } from './mappers';

export type WebSocketFactory = (url: string) => WebSocket;

// WebSocket.readyState OPEN — the standard numeric constant (1). Used instead of `WebSocket.OPEN`
// so this module never touches the global `WebSocket` (absent in node tests; we inject a fake there).
const WS_OPEN = 1;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Minimal JSON-RPC 2.0 client over one WebSocket, with id correlation, per-request timeout, reconnect. */
export class OgmiosClient {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly wsFactory: WebSocketFactory = (u) => new WebSocket(u),
  ) {}

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WS_OPEN) return Promise.resolve(this.ws);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const ws = this.wsFactory(this.url);
      ws.onopen = () => {
        this.ws = ws;
        resolve(ws);
      };
      ws.onerror = () => reject(new ProviderError(`ogmios: websocket error connecting to ${this.url}`));
      ws.onclose = () => {
        this.ws = null;
        this.failAll(new ProviderError('ogmios: socket closed'));
      };
      ws.onmessage = (ev: MessageEvent) => this.onMessage(ev);
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const ws = await this.connect();
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderTimeoutError(`ogmios: ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  private onMessage(ev: MessageEvent): void {
    let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as typeof msg;
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const p = this.pending.get(String(msg.id));
    if (!p) return;
    this.pending.delete(String(msg.id));
    clearTimeout(p.timer);
    if (msg.error) p.reject(new ProviderError(`ogmios: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* best effort */
    }
    this.ws = null;
  }
}

interface OgmiosUtxo {
  transaction: { id: string };
  index: number;
  address: string;
  value: { ada?: { lovelace?: number | bigint } } & Record<string, unknown>;
}
type OgmiosTip = 'origin' | { slot: number; id: string };

export class OgmiosProvider implements IChainProvider {
  readonly name = 'ogmios';
  readonly network: Network;
  private readonly client: OgmiosClient;

  constructor(
    network: Network,
    ogmiosUrl: string,
    opts: { timeoutMs?: number | undefined; wsFactory?: WebSocketFactory | undefined } = {},
  ) {
    const proto = new URL(ogmiosUrl).protocol;
    if (proto !== 'ws:' && proto !== 'wss:') {
      throw new Error(`ogmios: only ws:// or wss:// URLs allowed (got ${proto})`);
    }
    this.network = network;
    this.client = new OgmiosClient(ogmiosUrl, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, opts.wsFactory);
  }

  getGenesisInfos(): Promise<GenesisInfos> {
    return Promise.resolve(genesisInfosFor(this.network));
  }

  async getUtxos(address: string): Promise<UTxO[]> {
    const rows = await this.client.request<OgmiosUtxo[]>('queryLedgerState/utxo', { addresses: [address] });
    return rows.map((u) =>
      toUtxo({ txHash: u.transaction.id, outputIndex: u.index, address: u.address, amount: ogmiosValueToUnits(u.value) }),
    );
  }

  /**
   * APPROXIMATION: Ogmios has no historic tx index, so "used" = currently holds UTxOs. This misses
   * addresses that were used and later emptied — so gap-limit discovery over Ogmios alone can stop
   * early. Use a historical provider (Blockfrost) for authoritative discovery.
   */
  async isUsed(address: string): Promise<boolean> {
    const rows = await this.client.request<unknown[]>('queryLedgerState/utxo', { addresses: [address] });
    return rows.length > 0;
  }

  async resolveUtxos(refs: CanResolveToUTxO[]): Promise<UTxO[]> {
    const outputReferences = refs.map((ref) => {
      const r = forceTxOutRef(ref);
      return { transaction: { id: r.id.toString() }, index: r.index };
    });
    const rows = await this.client.request<OgmiosUtxo[]>('queryLedgerState/utxo', { outputReferences });
    return rows.map((u) =>
      toUtxo({ txHash: u.transaction.id, outputIndex: u.index, address: u.address, amount: ogmiosValueToUnits(u.value) }),
    );
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const p = await this.client.request<OgmiosParams>('queryLedgerState/protocolParameters', {});
    return mergeProtocolParameters({
      txFeePerByte: p.minFeeCoefficient ?? 0,
      txFeeFixed: Number(p.minFeeConstant?.ada?.lovelace ?? 0),
      maxTxSize: p.maxTransactionSize?.bytes ?? 0,
      maxBlockBodySize: p.maxBlockBodySize?.bytes ?? 0,
      maxBlockHeaderSize: p.maxBlockHeaderSize?.bytes ?? 0,
      utxoCostPerByte: BigInt(p.minUtxoDepositCoefficient ?? 0),
      stakeAddressDeposit: BigInt(p.stakeCredentialDeposit?.ada?.lovelace ?? 0),
      stakePoolDeposit: BigInt(p.stakePoolDeposit?.ada?.lovelace ?? 0),
      minPoolCost: BigInt(p.minStakePoolCost?.ada?.lovelace ?? 0),
      maxValueSize: BigInt(p.maxValueSize?.bytes ?? 0),
      collateralPercentage: p.collateralPercentage ?? 0,
      maxCollateralInputs: p.maxCollateralInputs ?? 0,
      executionUnitPrices: {
        priceMemory: parseRatio(p.scriptExecutionPrices?.memory),
        priceSteps: parseRatio(p.scriptExecutionPrices?.cpu),
      },
      maxTxExecutionUnits: {
        memory: p.maxExecutionUnitsPerTransaction?.memory ?? 0,
        steps: p.maxExecutionUnitsPerTransaction?.cpu ?? 0,
      },
      maxBlockExecutionUnits: {
        memory: p.maxExecutionUnitsPerBlock?.memory ?? 0,
        steps: p.maxExecutionUnitsPerBlock?.cpu ?? 0,
      },
      protocolVersion: { major: p.version?.major ?? 0, minor: p.version?.minor ?? 0 },
      // Real Plutus cost models — required for a correct scriptDataHash (verified live: a Plutus V3
      // spend built with these passes Ogmios evaluateTransaction without PPViewHashesDontMatch).
      ...(p.plutusCostModels
        ? {
            costModels: costModelsFromArrays({
              v1: p.plutusCostModels['plutus:v1'],
              v2: p.plutusCostModels['plutus:v2'],
              v3: p.plutusCostModels['plutus:v3'],
            }),
          }
        : {}),
    });
  }

  async submitTx(txCbor: string): Promise<string> {
    const res = await this.client.request<{ transaction: { id: string } }>('submitTransaction', {
      transaction: { cbor: txCbor },
    });
    return res.transaction.id;
  }

  async evaluateTx(txCbor: string): Promise<ScriptEvalResult[]> {
    return this.client.request<ScriptEvalResult[]>('evaluateTransaction', { transaction: { cbor: txCbor } });
  }

  async getTip(): Promise<ChainTip> {
    const [tip, height] = await Promise.all([
      this.client.request<OgmiosTip>('queryLedgerState/tip', {}),
      this.client.request<'origin' | number>('queryNetwork/blockHeight', {}),
    ]);
    const point = tip === 'origin' ? { slot: 0, id: '' } : tip;
    return { slot: point.slot, hash: point.id, height: height === 'origin' ? 0 : height };
  }

  close(): void {
    this.client.close();
  }
}

interface OgmiosCostModels {
  'plutus:v1'?: number[];
  'plutus:v2'?: number[];
  'plutus:v3'?: number[];
}

interface OgmiosParams {
  plutusCostModels?: OgmiosCostModels;
  minFeeCoefficient?: number;
  minFeeConstant?: { ada?: { lovelace?: number | bigint } };
  maxTransactionSize?: { bytes?: number };
  maxBlockBodySize?: { bytes?: number };
  maxBlockHeaderSize?: { bytes?: number };
  minUtxoDepositCoefficient?: number | bigint;
  stakeCredentialDeposit?: { ada?: { lovelace?: number | bigint } };
  stakePoolDeposit?: { ada?: { lovelace?: number | bigint } };
  minStakePoolCost?: { ada?: { lovelace?: number | bigint } };
  maxValueSize?: { bytes?: number };
  collateralPercentage?: number;
  maxCollateralInputs?: number;
  scriptExecutionPrices?: { memory?: string; cpu?: string };
  maxExecutionUnitsPerTransaction?: { memory?: number; cpu?: number };
  maxExecutionUnitsPerBlock?: { memory?: number; cpu?: number };
  version?: { major?: number; minor?: number };
}
