// Transaction building (EXECUTION_PLAN T3.1). Pure & framework-free: wraps buildooor's TxBuilder +
// keepRelevant coin selection. No chrome.*, no keys — produces an UNSIGNED tx; signing is separate
// (T3.2) and gated by user approval (CLAUDE.md §1.4). ADA + native-asset sends; metadata/Plutus later.
import {
  Address,
  TxBuilder,
  Value,
  type GenesisInfos,
  type ProtocolParameters,
  type Tx,
  type UTxO,
} from '@harmoniclabs/buildooor';

export interface BuildContext {
  protocolParameters: ProtocolParameters;
  genesisInfos: GenesisInfos;
  /** Candidate UTxOs to fund the tx (the wallet's available UTxOs). */
  utxos: UTxO[];
  /** Where leftover value returns — an (unused) change address owned by the wallet. */
  changeAddress: string;
}

export interface SendOutput {
  toAddress: string;
  lovelace: bigint;
  /** Optional native assets: unit (policyHex+assetNameHex) → quantity. */
  assets?: Array<{ unit: string; quantity: bigint }>;
}

/** Build a single-output payment. Throws if funds are insufficient or the address is invalid. */
export function buildSend(ctx: BuildContext, out: SendOutput): Tx {
  if (out.lovelace <= 0n) throw new Error('amount must be greater than zero');

  const tb = new TxBuilder(ctx.protocolParameters, ctx.genesisInfos);

  const units = [
    { unit: 'lovelace', quantity: out.lovelace.toString() },
    ...(out.assets ?? []).map((a) => ({ unit: a.unit, quantity: a.quantity.toString() })),
  ];
  const outputValue = Value.fromUnits(units);

  const inputs = tb.keepRelevant(outputValue, ctx.utxos.map((utxo) => ({ utxo })));
  if (inputs.length === 0) throw new Error('insufficient funds');

  return tb.buildSync({
    inputs,
    outputs: [{ address: Address.fromString(out.toAddress), value: outputValue }],
    changeAddress: ctx.changeAddress,
  });
}
