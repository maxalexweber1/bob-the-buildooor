// Coin selection (EXECUTION_PLAN T3.1). Our OWN selection — buildooor's `keepRelevant` is currently
// broken: it over-selects (grabs every UTxO), inflating tx size/fee and consolidating native assets
// into one UTxO (so no ADA-only UTxO remains for collateral). See:
//   https://github.com/HarmonicLabs/buildooor/pull/12
// TODO: revert to buildooor's `keepRelevant` once PR #12 is merged & released, then delete this file.
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

/** Default headroom over the requested lovelace: covers fee + min-ADA of a change output (~2 ADA). */
export const DEFAULT_FEE_BUFFER = 2_000_000n;

export function selectInputs(
  utxos: UTxO[],
  target: SelectionTarget,
  feeBuffer: bigint = DEFAULT_FEE_BUFFER,
): UTxO[] {
  const need = new Map<string, bigint>([['lovelace', target.lovelace + feeBuffer]]);
  for (const [unit, qty] of target.assets ?? []) need.set(unit, qty);

  // Largest lovelace first — minimizes input count (and thus tx size & fee) vs grabbing everything.
  const sorted = [...utxos].sort((a, b) =>
    b.resolved.value.lovelaces > a.resolved.value.lovelaces ? 1 : -1,
  );

  const have = new Map<string, bigint>();
  const covered = () => [...need].every(([unit, qty]) => (have.get(unit) ?? 0n) >= qty);

  const picked: UTxO[] = [];
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
