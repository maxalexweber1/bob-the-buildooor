// Coin selection (EXECUTION_PLAN T3.1). Our OWN selection, kept BY CHOICE: buildooor 0.2.9 fixed
// `keepRelevant`'s over-selection (our PR #12), but it still (a) uses a fixed 5-ADA headroom instead
// of a per-input rising fee bar, (b) does not sort its lovelace top-up (more inputs → bigger fee),
// and (c) has no ADA-only preference — which the CIP-113 funding path relies on so unrelated token
// bundles never ride through a Plutus tx (see core/cip113/transfer.ts).
//
// Strategy: largest-lovelace-first accumulation until the requested value (ADA + every native asset)
// is covered, plus a buffer for the fee and the min-ADA of the change output. Deterministic.
import type { UTxO } from '@harmoniclabs/buildooor';
import { valueView } from '../balance';

export interface SelectionTarget {
  lovelace: bigint;
  /** unit (policyHex+assetNameHex) → quantity. */
  assets?: Map<string, bigint>;
}

/** Base headroom over the requested lovelace: covers the fee + min-ADA of a change output (~2 ADA). */
export const DEFAULT_FEE_BUFFER = 2_000_000n;

/**
 * Extra headroom added PER selected input. A bigger input set means a bigger tx and a higher fee, so a
 * flat buffer can under-fund a many-input / multi-asset send — which then fails deep inside the builder
 * instead of here (review #-low). Scaling the requirement by input count keeps enough margin; any
 * surplus simply returns to the change output.
 */
export const PER_INPUT_BUFFER = 100_000n;

export function selectInputs(
  utxos: UTxO[],
  target: SelectionTarget,
  feeBuffer: bigint = DEFAULT_FEE_BUFFER,
): UTxO[] {
  const assetNeed = new Map<string, bigint>(target.assets ?? []);

  // Largest lovelace first — minimizes input count (and thus tx size & fee) vs grabbing everything.
  const sorted = [...utxos].sort((a, b) =>
    b.resolved.value.lovelaces > a.resolved.value.lovelaces ? 1 : -1,
  );

  const have = new Map<string, bigint>();
  const picked: UTxO[] = [];
  // The lovelace bar rises as inputs accrue, so each picked input also covers its own marginal fee.
  const lovelaceNeed = (): bigint => target.lovelace + feeBuffer + PER_INPUT_BUFFER * BigInt(picked.length);
  const covered = (): boolean =>
    (have.get('lovelace') ?? 0n) >= lovelaceNeed() &&
    [...assetNeed].every(([unit, qty]) => (have.get(unit) ?? 0n) >= qty);

  for (const u of sorted) {
    if (covered()) break;
    picked.push(u);
    const v = valueView(u.resolved.value);
    have.set('lovelace', (have.get('lovelace') ?? 0n) + BigInt(v.lovelace));
    for (const a of v.assets) have.set(a.unit, (have.get(a.unit) ?? 0n) + BigInt(a.quantity));
  }

  if (!covered()) throw new Error('insufficient funds');
  return picked;
}
