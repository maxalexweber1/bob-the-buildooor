// Collateral selection (EXECUTION_PLAN T5.2). Plutus phase-2 validation forfeits collateral on script
// failure, so collateral must be ADA-only (no native assets) and sufficient. We pick the SMALLEST
// adequate ADA-only UTxO — don't lock a large UTxO as collateral. Pure & framework-free.
import type { UTxO } from '@harmoniclabs/buildooor';
import { valueView } from '../balance';

/** Default collateral floor (~5 ADA comfortably covers collateralPercentage of any small-tx fee). */
export const DEFAULT_COLLATERAL_LOVELACE = 5_000_000n;

function isAdaOnly(u: UTxO): boolean {
  return valueView(u.resolved.value).assets.length === 0;
}

/** Smallest ADA-only UTxO ≥ minLovelace, or null if none qualifies. */
export function selectCollateral(utxos: UTxO[], minLovelace: bigint = DEFAULT_COLLATERAL_LOVELACE): UTxO | null {
  const candidates = utxos
    .filter((u) => isAdaOnly(u) && u.resolved.value.lovelaces >= minLovelace)
    .sort((a, b) => (a.resolved.value.lovelaces > b.resolved.value.lovelaces ? 1 : -1));
  return candidates[0] ?? null;
}
