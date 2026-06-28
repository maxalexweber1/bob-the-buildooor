// Capability-splitting composite provider (IMPLEMENTATION_PLAN §7 multi-backend orchestration).
//
// Motivation: a local stack (Ogmios + Kupo) is great for params/submit/evaluate and indexed UTxO
// reads, but has NO transaction history, NO asset display-metadata (token names/images), NO
// asset-holder index (ADA Handles), and no confirmation lookup. A remote indexer (Blockfrost/Koios)
// has all of those. This composite uses `primary` for the core chain reads/writes and borrows those
// indexed extras from an optional `secondary` — "Kupo+Ogmios for state, Blockfrost for history".
//
// Each OPTIONAL capability is exposed on the composite only when primary OR secondary actually
// implements it (primary preferred), so a caller's `provider.getAssetMetadata ? …` capability check
// still reflects real support rather than always seeing a method that throws.
import type { CanResolveToUTxO, GenesisInfos, ProtocolParameters, UTxO } from '@harmoniclabs/buildooor';
import type { IChainProvider, Network } from './IChainProvider';

export class CompositeProvider implements IChainProvider {
  readonly name: string;
  readonly network: Network;

  // Optional capabilities — bound in the constructor to whichever backend implements them.
  // `NonNullable` strips the `| undefined` from the indexed type so the field matches the interface's
  // optional-method member exactly (a property may be ABSENT, but never explicitly `undefined`).
  readonly evaluateTx?: NonNullable<IChainProvider['evaluateTx']>;
  readonly getTip?: NonNullable<IChainProvider['getTip']>;
  readonly isConfirmed?: NonNullable<IChainProvider['isConfirmed']>;
  readonly getAssetMetadata?: NonNullable<IChainProvider['getAssetMetadata']>;
  readonly getAssetAddresses?: NonNullable<IChainProvider['getAssetAddresses']>;
  readonly getAddressTransactions?: NonNullable<IChainProvider['getAddressTransactions']>;
  readonly getTxDetail?: NonNullable<IChainProvider['getTxDetail']>;
  readonly getUtxosForAddresses?: NonNullable<IChainProvider['getUtxosForAddresses']>;

  /**
   * Where address/UTxO reads (`getUtxos`/`isUsed`/`resolveUtxos`) go. Defaults to `primary`, but for
   * an Ogmios-without-Kupo + remote-indexer setup we point it at the remote: plain Ogmios scans the
   * whole UTxO set per address (~8 s → timeouts), so the remote serves reads while Ogmios keeps
   * submit + Plutus evaluate.
   */
  private readonly reads: IChainProvider;

  constructor(
    private readonly primary: IChainProvider,
    private readonly secondary?: IChainProvider,
    opts: { reads?: IChainProvider } = {},
  ) {
    this.reads = opts.reads ?? primary;
    this.network = primary.network;
    this.name = secondary ? `${primary.name}+${secondary.name}` : primary.name;

    // Prefer the primary's implementation, fall back to the secondary's. We ONLY assign when a backend
    // actually provides the method — leaving the property absent otherwise (not `undefined`), so the
    // optional-method contract holds under `exactOptionalPropertyTypes` and a caller's `provider.X ?`
    // capability check reflects real support.
    const evaluateTx = primary.evaluateTx?.bind(primary) ?? secondary?.evaluateTx?.bind(secondary);
    if (evaluateTx) this.evaluateTx = evaluateTx;
    const getTip = primary.getTip?.bind(primary) ?? secondary?.getTip?.bind(secondary);
    if (getTip) this.getTip = getTip;
    const isConfirmed = primary.isConfirmed?.bind(primary) ?? secondary?.isConfirmed?.bind(secondary);
    if (isConfirmed) this.isConfirmed = isConfirmed;
    const getAssetMetadata = primary.getAssetMetadata?.bind(primary) ?? secondary?.getAssetMetadata?.bind(secondary);
    if (getAssetMetadata) this.getAssetMetadata = getAssetMetadata;
    const getAssetAddresses = primary.getAssetAddresses?.bind(primary) ?? secondary?.getAssetAddresses?.bind(secondary);
    if (getAssetAddresses) this.getAssetAddresses = getAssetAddresses;
    const getAddressTransactions =
      primary.getAddressTransactions?.bind(primary) ?? secondary?.getAddressTransactions?.bind(secondary);
    if (getAddressTransactions) this.getAddressTransactions = getAddressTransactions;
    const getTxDetail = primary.getTxDetail?.bind(primary) ?? secondary?.getTxDetail?.bind(secondary);
    if (getTxDetail) this.getTxDetail = getTxDetail;
    // Batched read follows the read provider, not the state primary.
    const getUtxosForAddresses = this.reads.getUtxosForAddresses?.bind(this.reads);
    if (getUtxosForAddresses) this.getUtxosForAddresses = getUtxosForAddresses;
  }

  // ---- core chain state / reads / writes: always the primary ----
  getGenesisInfos(): Promise<GenesisInfos> {
    return this.primary.getGenesisInfos();
  }
  getProtocolParameters(): Promise<ProtocolParameters> {
    return this.primary.getProtocolParameters();
  }
  getUtxos(address: string): Promise<UTxO[]> {
    return this.reads.getUtxos(address);
  }
  isUsed(address: string): Promise<boolean> {
    return this.reads.isUsed(address);
  }
  resolveUtxos(refs: CanResolveToUTxO[]): Promise<UTxO[]> {
    return this.reads.resolveUtxos(refs);
  }
  submitTx(txCbor: string): Promise<string> {
    return this.primary.submitTx(txCbor);
  }

  /** Close every distinct backend (e.g. the Ogmios WebSocket) when the provider is replaced. */
  close(): void {
    this.primary.close?.();
    if (this.secondary && this.secondary !== this.primary) this.secondary.close?.();
    if (this.reads !== this.primary && this.reads !== this.secondary) this.reads.close?.();
  }
}
