import { describe, it, expect } from 'vitest';
import { DataConstr, DataI, DataB } from '@harmoniclabs/buildooor';
import {
  normalizeDataJson,
  plutusDataFromJson,
  plutusDataToJson,
  plutusDataFromCbor,
  plutusDataToCbor,
} from '../src/core/tx/plutusData';

describe('normalizeDataJson (T5.1)', () => {
  it('renames CSL "constructor" → buildooor "constr", recursively', () => {
    const input = { constructor: 0, fields: [{ int: 1 }, { constructor: 1, fields: [{ bytes: 'ab' }] }] };
    expect(normalizeDataJson(input)).toEqual({ constr: 0, fields: [{ int: 1 }, { constr: 1, fields: [{ bytes: 'ab' }] }] });
  });

  it('does NOT spuriously add constr to a plain int (the prototype-chain trap)', () => {
    // `'constructor' in {int:5}` is true via the prototype — Object.keys avoids that.
    expect(normalizeDataJson({ int: 5 })).toEqual({ int: 5 });
  });

  it('coerces a numeric-string int to bigint (precision for large datum ints)', () => {
    expect(normalizeDataJson({ int: '90071992547409910' })).toEqual({ int: 90071992547409910n });
  });
});

describe('plutusData JSON/CBOR conversions (T5.1)', () => {
  it('builds Data from "constructor"-style JSON matching buildooor canonical CBOR', () => {
    const fromJson = plutusDataFromJson({ constructor: 0, fields: [{ int: 42 }, { bytes: 'deadbeef' }] });
    const fromCtor = new DataConstr(0, [new DataI(42n), new DataB('deadbeef')]);
    expect(plutusDataToCbor(fromJson)).toBe(plutusDataToCbor(fromCtor));
    // sanity: known CBOR for constr-0 [42, deadbeef]
    expect(plutusDataToCbor(fromJson)).toBe('d8799f182a44deadbeefff');
  });

  it('CBOR round-trips exactly', () => {
    const hex = 'd8799f182a44deadbeefff';
    expect(plutusDataToCbor(plutusDataFromCbor(hex))).toBe(hex);
  });

  it('toJson round-trips structurally through fromJson', () => {
    const json = { constr: 1, fields: [{ int: 7 }, { list: [{ int: 1 }, { bytes: 'ff' }] }] };
    const data = plutusDataFromJson(json);
    const back = plutusDataToJson(data);
    // re-build from the emitted JSON and compare CBOR — the canonical equality check.
    expect(plutusDataToCbor(plutusDataFromJson(back))).toBe(plutusDataToCbor(data));
  });

  it('preserves a large integer through JSON → Data → CBOR', () => {
    const big = '170141183460469231731687303715884105727'; // > 2^53
    const data = plutusDataFromJson({ int: big });
    expect(plutusDataToCbor(plutusDataFromCbor(plutusDataToCbor(data)))).toBe(plutusDataToCbor(data));
    expect(plutusDataToJson(data)).toEqual({ int: big });
  });
});
