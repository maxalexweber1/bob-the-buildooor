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

/** A reference to a transaction touching an address (history listing), newest first. */
export interface AddressTxRef {
  txHash: string;
  /** Unix seconds of the containing block (0 if unknown). */
  blockTime: number;
  blockHeight: number;
}

/** Full input/output detail of a tx — enough to compute the wallet's net delta (T-history). */
export interface TxIODetail {
  txHash: string;
  inputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>;
  outputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>;
  fee?: string;
}

/**
 * Display metadata for a native asset (CIP-25 on-chain / CIP-68 / off-chain CIP-26 registry). Text
 * only — the wallet renders the name/description; `image` is captured but NOT yet shown (rendering
 * remote/IPFS images needs a CSP `img-src` decision + privacy review, IMPLEMENTATION_PLAN §1.7/§10).
 */
export interface AssetMetadata {
  /** Human display name (CIP-25/68 `name`, else off-chain registry name). */
  name?: string;
  description?: string;
  /** Image URI (`ipfs://…` or `https://…`). Stored, not rendered yet. */
  image?: string;
  /** Decimals for fungible tokens (off-chain registry / CIP-68 333). */
  decimals?: number;
  /** Provider-reported standard, e.g. "CIP25v1", "CIP25v2", "CIP68v1". */
  standard?: string;
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
  /**
   * Batched multi-address UTxO query — every UTxO held by ANY of `addresses`, in one round-trip.
   * The point is Ogmios: its `queryLedgerState/utxo` has no address index and scans the whole ledger
   * UTxO set per call, so a gap-limit discovery of ~40 one-address queries blows the SW timeout. Passing
   * the whole address window in one call pays that scan ONCE for the batch. Optional: providers with a
   * per-address index (Blockfrost/Koios) omit it and callers fall back to parallel `getUtxos`.
   */
  getUtxosForAddresses?(addresses: string[]): Promise<UTxO[]>;
  /** Authoritative Plutus ex-units (Ogmios). Absent on Blockfrost-REST / gerolamo for now. */
  evaluateTx?(txCbor: string): Promise<ScriptEvalResult[]>;
  getTip?(): Promise<ChainTip>;
  /** Has this tx hash been included on-chain? Drives post-submit confirmation polling (needs history). */
  isConfirmed?(txHash: string): Promise<boolean>;
  /**
   * Display metadata for an asset `unit` (policyId+assetNameHex). Null when unknown/unsupported. Used
   * to show NFT/token names beyond the on-chain asset name. Kupo/Ogmios have no metadata index → omit.
   */
  getAssetMetadata?(unit: string): Promise<AssetMetadata | null>;
  /**
   * Addresses currently holding asset `unit` (policyId+assetNameHex), with quantities. Resolves ADA
   * Handles to their current holder (T8.1, `core/handle.ts`). Needs an asset-holder index → Blockfrost
   * and Koios provide it; Ogmios (no asset index) omits it and the caller reports it unsupported.
   */
  getAssetAddresses?(unit: string): Promise<{ address: string; quantity: string }[]>;

  /**
   * Is this reward (stake) address registered on-chain (stake-key registration certificate, not yet
   * deregistered)? Drives CIP-95 `getRegisteredPubStakeKeys` / `getUnregisteredPubStakeKeys` (T6.1).
   * `stakeAddress` is bech32 (`stake1…`/`stake_test1…`). Omitted → callers report keys as
   * unregistered, which CIP-95 prescribes for unknown registration state.
   */
  getStakeRegistration?(stakeAddress: string): Promise<boolean>;

  // ---- transaction history (needs historic state: Blockfrost/Koios; Ogmios omits → unsupported) ----
  /** Transactions touching an address, newest first; `page` is 1-based. */
  getAddressTransactions?(address: string, page?: number): Promise<AddressTxRef[]>;
  /** Full IO of a tx, for computing the wallet's net effect. */
  getTxDetail?(txHash: string): Promise<TxIODetail>;

  /**
   * Release long-lived resources (e.g. the Ogmios WebSocket). Stateless HTTP providers omit it. The
   * provider cache calls this before discarding a provider so sockets don't leak on settings changes.
   */
  close?(): void;
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
