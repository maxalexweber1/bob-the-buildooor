// Strict hex decoding: malformed hex on a signing path must be REJECTED, never coerced
// (parseInt('zz',16) → NaN → 0x00 would sign different bytes than the caller sent).
import { describe, it, expect } from 'vitest';
import { fromHex, toHex } from '../src/core/crypto/encoding';

describe('fromHex is strict', () => {
  it('decodes valid lowercase hex', () => {
    expect(fromHex('00ff10')).toEqual(new Uint8Array([0, 255, 16]));
  });

  it('decodes valid UPPERCASE and mixed-case hex', () => {
    expect(fromHex('DEADbeef')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it('accepts an optional 0x prefix', () => {
    expect(fromHex('0x00ff')).toEqual(new Uint8Array([0, 255]));
  });

  it('accepts the empty string (zero bytes)', () => {
    expect(fromHex('')).toEqual(new Uint8Array(0));
  });

  it('rejects non-hex characters instead of coercing to 0x00', () => {
    expect(() => fromHex('zz')).toThrow();
    expect(() => fromHex('00zz')).toThrow();
    expect(() => fromHex('0xgg')).toThrow();
    expect(() => fromHex('68 69')).toThrow(); // embedded whitespace
    expect(() => fromHex('68-69')).toThrow();
  });

  it('rejects odd-length hex', () => {
    expect(() => fromHex('0')).toThrow();
    expect(() => fromHex('0x0')).toThrow();
    expect(() => fromHex('abc')).toThrow();
  });

  it('round-trips with toHex', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });
});
