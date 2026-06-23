// PlutusData JSON ↔ Data ↔ CBOR (EXECUTION_PLAN T5.1). Datums and redeemers reach us as JSON (from a
// dApp or the user) and must become buildooor `Data`; we also render Data back to JSON for the approval
// UI. Pure & framework-free.
//
// GOTCHA (CLAUDE.md odatano): buildooor's detailed schema uses `"constr"`, but inbound JSON often uses
// the CSL/cardano-cli `"constructor"`. We rename it — and we detect own keys via `Object.keys`
// (never `'constructor' in obj`, which is always true via the prototype chain).
import {
  Data,
  DataB,
  DataConstr,
  DataI,
  DataList,
  DataMap,
  dataFromCbor,
  dataFromJson,
  dataToCbor,
} from '@harmoniclabs/buildooor';
import { fromHex, toHex } from '../crypto/encoding';

export type PlutusDataJson =
  | { int: number | string }
  | { bytes: string }
  | { list: PlutusDataJson[] }
  | { map: Array<{ k: PlutusDataJson; v: PlutusDataJson }> }
  | { constr: number; fields: PlutusDataJson[] };

/** Recursively rename CSL-style `"constructor"` keys to buildooor's `"constr"`, and coerce string
 *  integers to bigint so large datum/redeemer ints survive (JSON has no bigint). */
export function normalizeDataJson(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(normalizeDataJson);
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      const key = k === 'constructor' ? 'constr' : k;
      // Preserve exact precision for `int` provided as a numeric string.
      if (key === 'int' && typeof obj[k] === 'string') out[key] = BigInt(obj[k] as string);
      else out[key] = normalizeDataJson(obj[k]);
    }
    return out;
  }
  return json;
}

/** Detailed-schema JSON (constr or constructor style) → buildooor Data. Throws on malformed input. */
export function plutusDataFromJson(json: unknown): Data {
  return dataFromJson(normalizeDataJson(json) as Parameters<typeof dataFromJson>[0]);
}

export function plutusDataFromCbor(hex: string): Data {
  return dataFromCbor(fromHex(hex));
}

/** Data → CBOR hex (what the tx builder consumes for datums/redeemers). Exact, bigint-preserving. */
export function plutusDataToCbor(data: Data): string {
  return toHex(dataToCbor(data));
}

/** Data → detailed-schema JSON (`constr` style). For the approval UI — buildooor has no dataToJson. */
export function plutusDataToJson(data: Data): PlutusDataJson {
  if (data instanceof DataConstr) {
    return { constr: Number(data.constr), fields: data.fields.map(plutusDataToJson) };
  }
  if (data instanceof DataI) {
    const n = data.int;
    return { int: n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString() };
  }
  if (data instanceof DataB) {
    return { bytes: byteStringHex(data) };
  }
  if (data instanceof DataList) {
    return { list: data.list.map(plutusDataToJson) };
  }
  if (data instanceof DataMap) {
    return { map: data.map.map((p) => ({ k: plutusDataToJson(p.fst), v: plutusDataToJson(p.snd) })) };
  }
  throw new Error('unknown PlutusData variant');
}

function byteStringHex(b: DataB): string {
  const bytes = b.bytes as unknown as { toBuffer?: () => Uint8Array } | Uint8Array;
  if (bytes instanceof Uint8Array) return toHex(bytes);
  return toHex(bytes.toBuffer ? bytes.toBuffer() : new Uint8Array());
}
