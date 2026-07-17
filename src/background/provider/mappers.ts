// Shared response→buildooor mappers (T2.2/T2.3). Both Blockfrost and Ogmios normalize their UTxO
// payloads to a `{ unit, quantity }[]` amount list, then we build a buildooor `UTxO` from it.
// Adapted from ODATANO's backend mappers (the value/ratio edge cases were learned there).
import {
  Address,
  Hash32,
  UTxO,
  Value,
  dataFromCbor,
  defaultProtocolParameters,
  toCostModelV1,
  toCostModelV2,
  toCostModelV3,
  type CostModels,
  type Data,
  type ProtocolParameters,
} from '@harmoniclabs/buildooor';
import { fromHex } from '../../core/crypto/encoding';

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
  /** Datum hash (hex), when the output carries a hash-only datum. */
  datumHash?: string | null | undefined;
  /** Inline datum as PlutusData CBOR hex (CIP-32) — needed by the CIP-113 registry client (T9.1). */
  inlineDatum?: string | null | undefined;
  // refScript is intentionally not mapped yet — script UTxOs reach the builder via resolveUtxos.
  scriptRef?: string | null | undefined;
}

/** Datum for a mapped UTxO: inline (CIP-32) wins over a hash. Chain data is untrusted — a datum that
 *  doesn't parse as PlutusData is dropped rather than failing the whole balance/UTxO query. */
function toDatum(raw: RawUtxo): Hash32 | Data | undefined {
  if (raw.inlineDatum) {
    try {
      return dataFromCbor(fromHex(raw.inlineDatum));
    } catch {
      return undefined;
    }
  }
  if (raw.datumHash) {
    try {
      return new Hash32(raw.datumHash);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Build a buildooor `UTxO` (address + value + datum) from a normalized raw UTxO. */
export function toUtxo(raw: RawUtxo): UTxO {
  const datum = toDatum(raw);
  return new UTxO({
    utxoRef: { id: raw.txHash, index: raw.outputIndex },
    resolved: {
      address: Address.fromString(raw.address),
      value: Value.fromUnits(raw.amount),
      ...(datum !== undefined ? { datum } : {}),
    },
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

/**
 * Map per-language cost-model vectors (the ledger's flat number[] for each Plutus version) into
 * buildooor `CostModels`. Required for a correct `scriptDataHash` — the buildooor default cost models
 * do NOT match the chain (verified live: a Plutus tx built with these passes Ogmios evaluateTransaction
 * without PPViewHashesDontMatch). All providers expose the same vectors under different keys:
 *   Ogmios `plutus:v1/v2/v3`, Blockfrost `cost_models_raw.PlutusV1/V2/V3`, Koios `costModels.PlutusV1…`.
 * The node returns a flat number[]; buildooor types these as fixed-length tuples — cast to each fn's param.
 */
export function costModelsFromArrays(v: {
  v1?: number[] | undefined;
  v2?: number[] | undefined;
  v3?: number[] | undefined;
}): CostModels {
  const out: CostModels = {};
  if (v.v1) out.PlutusScriptV1 = toCostModelV1(v.v1 as Parameters<typeof toCostModelV1>[0]);
  if (v.v2) out.PlutusScriptV2 = toCostModelV2(v.v2 as Parameters<typeof toCostModelV2>[0]);
  if (v.v3) out.PlutusScriptV3 = toCostModelV3(v.v3 as Parameters<typeof toCostModelV3>[0]);
  return out;
}

// ---- Asset display-metadata field pickers (shared by Blockfrost & Koios getAssetMetadata) ----
// Provider asset metadata is freeform JSON; pick known display fields defensively (trust-no-input).

/** Non-empty string, else undefined. */
export function pickString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
/** Finite number, else undefined. */
export function pickNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
/** Image URI: a plain string, or a CIP-25 v1 chunked string[] joined into one URI. */
export function joinImageUri(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (Array.isArray(v)) {
    const joined = v.filter((x): x is string => typeof x === 'string').join('');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}
