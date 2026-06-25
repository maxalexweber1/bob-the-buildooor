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
import { selectInputs } from './coinSelect';

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

/** CIP-20 memos are short by design; cap the total to keep tx size (and fee) bounded (~4 lines). */
export const MAX_MEMO_BYTES = 256;

export interface BuildOptions {
  /** Optional CIP-20 (label 674) message attached to the tx. buildooor splits it into ≤64-byte lines. */
  memo?: string;
}

/** Build a single-output payment. Throws if funds are insufficient or the address is invalid. */
export function buildSend(ctx: BuildContext, out: SendOutput, opts: BuildOptions = {}): Tx {
  if (out.lovelace <= 0n) throw new Error('amount must be greater than zero');

  const memo = opts.memo?.trim();
  if (memo !== undefined && memo.length > 0 && new TextEncoder().encode(memo).length > MAX_MEMO_BYTES) {
    throw new Error(`memo too long (max ${MAX_MEMO_BYTES} bytes)`);
  }

  // Reject a recipient on the wrong network (e.g. a mainnet `addr1…` while the wallet is on testnet).
  // bech32 alone doesn't catch this; without the check the tx would build and the user could send to
  // an address they can never reach on this network (review #-nit, fund safety).
  const recipient = Address.fromString(out.toAddress);
  const ownNetwork = Address.fromString(ctx.changeAddress).network;
  if (recipient.network !== ownNetwork) {
    throw new Error(`wrong network: recipient is a ${recipient.network} address but the wallet is on ${ownNetwork}`);
  }

  const tb = new TxBuilder(ctx.protocolParameters, ctx.genesisInfos);

  const units = [
    { unit: 'lovelace', quantity: out.lovelace.toString() },
    ...(out.assets ?? []).map((a) => ({ unit: a.unit, quantity: a.quantity.toString() })),
  ];
  const outputValue = Value.fromUnits(units);

  // Our own coin selection (buildooor's keepRelevant is broken — see coinSelect.ts).
  const assets = new Map((out.assets ?? []).map((a) => [a.unit, a.quantity]));
  const selected = selectInputs(ctx.utxos, { lovelace: out.lovelace, assets });

  return tb.buildSync({
    inputs: selected.map((utxo) => ({ utxo })),
    outputs: [{ address: recipient, value: outputValue }],
    changeAddress: ctx.changeAddress,
    // buildooor wraps the string into CIP-20 label-674 `{msg:[…≤64B chunks]}` automatically.
    ...(memo !== undefined && memo.length > 0 ? { memo } : {}),
  });
}
