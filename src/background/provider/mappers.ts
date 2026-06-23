// Shared response→buildooor mappers (T2.2/T2.3). Both Blockfrost and Ogmios normalize their UTxO
// payloads to a `{ unit, quantity }[]` amount list, then we build a buildooor `UTxO` from it.
// Adapted from ODATANO's backend mappers (the value/ratio edge cases were learned there).
import { Address, UTxO, Value, defaultProtocolParameters, type ProtocolParameters } from '@harmoniclabs/buildooor';

/** Blockfrost-style amount entry; also the normalized form we convert Ogmios values into. */
export interface AmountUnit {
  unit: string; // 'lovelace' | `${policyHex}${assetNameHex}`
  quantity: string;
}

export interface RawUtxo {
  txHash: string;
  outputIndex: number;
  address: string;
  amount: AmountUnit[];
  // datum/refScript are intentionally not mapped yet — needed for Plutus (M5 / T5.4), not for
  // balance & coin selection. Carried here so the mapper signature is stable when we add them.
  datumHash?: string | null;
  inlineDatum?: string | null;
  scriptRef?: string | null;
}

/** Build a buildooor `UTxO` (address + value) from a normalized raw UTxO. */
export function toUtxo(raw: RawUtxo): UTxO {
  return new UTxO({
    utxoRef: { id: raw.txHash, index: raw.outputIndex },
    resolved: { address: Address.fromString(raw.address), value: Value.fromUnits(raw.amount) },
  });
}

/**
 * Ogmios value → `{ unit, quantity }[]`. Ogmios v6 shape:
 *   { ada: { lovelace: 1000000 }, "<policyHex>": { "<assetNameHex>": 7 } }
 * (Calling `.toString()` directly on the `{ ada: { lovelace } }` object yields "[object Object]"
 * — an ODATANO bug; we read `.ada.lovelace` explicitly.)
 */
export function ogmiosValueToUnits(
  value: { ada?: { lovelace?: number | bigint } } & Record<string, unknown>,
): AmountUnit[] {
  const out: AmountUnit[] = [];
  const lovelace = value.ada?.lovelace;
  if (lovelace !== undefined) out.push({ unit: 'lovelace', quantity: lovelace.toString() });

  for (const [policyId, assets] of Object.entries(value)) {
    if (policyId === 'ada') continue;
    for (const [assetName, qty] of Object.entries(assets as Record<string, number | bigint | string>)) {
      out.push({ unit: `${policyId}${assetName}`, quantity: qty.toString() });
    }
  }
  return out;
}

/** Parse an Ogmios `Ratio` ("3/1000" → 0.003). `Number("3/1000")` is NaN, so every price would break. */
export function parseRatio(ratio: string | number | undefined | null): number {
  if (ratio === null || ratio === undefined) return 0;
  if (typeof ratio === 'number') return ratio;
  const m = /^(-?\d+)\s*\/\s*(\d+)$/.exec(ratio);
  if (m) {
    const den = Number(m[2]);
    return den === 0 ? 0 : Number(m[1]) / den;
  }
  const n = Number(ratio);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Start from buildooor's complete `defaultProtocolParameters` and override the dynamic fee/size/
 * ex-unit fields a provider supplies. This guarantees a valid, complete object usable directly as
 * `new TxBuilder(pp, genesis)`. NOTE: `costModels` is left at the default — real cost-model mapping
 * is deferred to Plutus work (M5/T5.x); non-Plutus tx building doesn't need it.
 */
export function mergeProtocolParameters(overrides: Partial<ProtocolParameters>): ProtocolParameters {
  return { ...defaultProtocolParameters, ...overrides };
}
