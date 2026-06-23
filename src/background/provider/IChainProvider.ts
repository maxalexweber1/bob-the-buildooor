// Chain-data provider abstraction (EXECUTION_PLAN T2.1; IMPLEMENTATION_PLAN §7).
//
// Design goals:
//  - Returns buildooor-native types (UTxO, Value, ProtocolParameters, GenesisInfos) so results feed
//    `TxBuilder`/`TxBuilderRunner` directly (the data methods mirror buildooor's own `IProvider`).
//  - Provider-agnostic: Blockfrost (remote REST), Ogmios (local/remote node WebSocket), and — later —
//    a `GerolamoProvider` pointing at an in-browser/local TS full node. Gerolamo today only resolves
//    UTxOs by output-ref and can't evaluate scripts, so capability-optional methods (`evaluateTx`,
//    `getTip`) are declared optional and a provider may also throw `ProviderUnsupportedError`. Adopting
//    gerolamo later is then purely additive — no interface break.
import type {
  GenesisInfos,
  ProtocolParameters,
  UTxO,
  CanResolveToUTxO,
} from '@harmoniclabs/buildooor';

export type Network = 'mainnet' | 'preview' | 'preprod';

export interface ChainTip {
  slot: number;
  hash: string;
  height: number;
}

/** One redeemer's execution-unit budget from an `evaluateTx` pass (Ogmios). Used by the M5 2-pass build. */
export interface ScriptEvalResult {
  /** Redeemer pointer — Ogmios returns `{ purpose, index }` (purpose: spend|mint|publish|withdraw|vote|propose). */
  validator: { purpose: string; index: number };
  budget: { memory: number; cpu: number };
}

export interface IChainProvider {
  readonly name: string;
  readonly network: Network;

  // ---- buildooor IProvider-compatible data methods ----
  getGenesisInfos(): Promise<GenesisInfos>;
  getProtocolParameters(): Promise<ProtocolParameters>;
  /** Resolve specific output refs → UTxOs (reference inputs / script UTxOs). */
  resolveUtxos(refs: CanResolveToUTxO[]): Promise<UTxO[]>;
  submitTx(txCbor: string): Promise<string>;

  // ---- wallet additions ----
  /** All UTxOs at an address — balance, asset list, coin-selection candidates. */
  getUtxos(address: string): Promise<UTxO[]>;
  /**
   * Has this address ever been used on-chain? Drives gap-limit discovery (T2.4). Blockfrost answers
   * authoritatively (tx history); Ogmios can only approximate from current UTxOs (no historic state).
   */
  isUsed(address: string): Promise<boolean>;

  // ---- optional capabilities (a provider may omit or throw ProviderUnsupportedError) ----
  /** Authoritative Plutus ex-units (Ogmios). Absent on Blockfrost-REST / gerolamo for now. */
  evaluateTx?(txCbor: string): Promise<ScriptEvalResult[]>;
  getTip?(): Promise<ChainTip>;
  /** Has this tx hash been included on-chain? Drives post-submit confirmation polling (needs history). */
  isConfirmed?(txHash: string): Promise<boolean>;
}

// ---- Errors ----

export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** The provider does not implement a requested capability (e.g. Blockfrost-REST `evaluateTx`). */
export class ProviderUnsupportedError extends ProviderError {
  constructor(providerName: string, method: string) {
    super(`${providerName} does not support ${method}`);
    this.name = 'ProviderUnsupportedError';
  }
}

export class ProviderHttpError extends ProviderError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(message = 'provider request timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}
