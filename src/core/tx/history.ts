// Transaction-history aggregation (pure, framework-free — no chrome.*, no provider import so core/
// stays independent). Given a tx's full inputs/outputs and the wallet's own addresses, compute the
// wallet's NET effect: how much ADA + which tokens actually entered or left the wallet, and whether
// it reads as received / sent / self-transfer. Unit-tested in isolation; the background just feeds it
// provider data and the own-address set.
import { decodeAssetName, type AssetBalance } from '../balance';

/** One side of a tx as the provider reports it: an address and its multi-asset amounts. */
export interface TxParty {
  address: string;
  /** unit ('lovelace' or policyHex+assetNameHex) → quantity (decimal string). */
  amount: Array<{ unit: string; quantity: string }>;
}

export interface TxDetailView {
  txHash: string;
  inputs: TxParty[];
  outputs: TxParty[];
  fee?: string;
}

export interface HistoryEntry {
  txHash: string;
  /** Unix seconds of the containing block (0 if the provider didn't supply it). */
  blockTime: number;
  /** 'in' = received (no own inputs); 'out' = spent; 'self' = consolidation/self-transfer. */
  direction: 'in' | 'out' | 'self';
  /** Net lovelace delta for the wallet — signed (negative when value left). */
  netLovelace: string;
  /** Net token deltas — signed quantities; empty when no tokens moved net. */
  netAssets: AssetBalance[];
  fee?: string;
  /** Best-effort other party: non-own output addrs for a send, non-own input addrs for a receive. */
  counterparties: string[];
}

function toAsset(unit: string, qty: bigint): AssetBalance {
  const policyId = unit.slice(0, 56);
  const assetNameHex = unit.slice(56);
  const utf8 = decodeAssetName(assetNameHex);
  const base: AssetBalance = { unit, policyId, assetNameHex, quantity: qty.toString() };
  return utf8 === undefined ? base : { ...base, assetNameUtf8: utf8 };
}

/** Add (sign +1) / subtract (sign -1) a party's amounts into the running per-unit delta. */
function accumulate(delta: Map<string, bigint>, parties: TxParty[], own: ReadonlySet<string>, sign: bigint): void {
  for (const p of parties) {
    if (!own.has(p.address)) continue;
    for (const a of p.amount) {
      delta.set(a.unit, (delta.get(a.unit) ?? 0n) + sign * BigInt(a.quantity));
    }
  }
}

function distinctNonOwn(parties: TxParty[], own: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const p of parties) {
    if (!own.has(p.address) && !out.includes(p.address)) out.push(p.address);
  }
  return out;
}

/** Reduce one tx (with full IO) to the wallet's net view. */
export function computeHistoryEntry(
  detail: TxDetailView,
  ownAddresses: ReadonlySet<string>,
  blockTime: number,
): HistoryEntry {
  const delta = new Map<string, bigint>();
  accumulate(delta, detail.outputs, ownAddresses, 1n); // value into the wallet
  accumulate(delta, detail.inputs, ownAddresses, -1n); // value out of the wallet

  const netLovelace = delta.get('lovelace') ?? 0n;
  const netAssets = [...delta]
    .filter(([unit, qty]) => unit !== 'lovelace' && qty !== 0n)
    .map(([unit, qty]) => toAsset(unit, qty));

  // 'in'   = we didn't spend (no own inputs) → someone sent to us.
  // 'out'  = we spent AND at least one output goes to a third party.
  // 'self' = we spent but every output returns to us (a consolidation; only the fee leaves).
  const hasOwnInput = detail.inputs.some((p) => ownAddresses.has(p.address));
  const nonOwnOutputs = distinctNonOwn(detail.outputs, ownAddresses);
  const direction: HistoryEntry['direction'] = !hasOwnInput ? 'in' : nonOwnOutputs.length > 0 ? 'out' : 'self';
  const counterparties = direction === 'in' ? distinctNonOwn(detail.inputs, ownAddresses) : nonOwnOutputs;

  const entry: HistoryEntry = {
    txHash: detail.txHash,
    blockTime,
    direction,
    netLovelace: netLovelace.toString(),
    netAssets,
    counterparties,
  };
  return detail.fee === undefined ? entry : { ...entry, fee: detail.fee };
}
