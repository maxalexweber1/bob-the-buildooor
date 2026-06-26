import { describe, it, expect } from 'vitest';
import {
  HANDLE_POLICY_ID,
  HandleError,
  looksLikeHandle,
  normalizeHandle,
  handleToUnits,
  resolveHandle,
  type AssetHolder,
} from '../src/core/handle';

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

/** A fake on-chain lookup: maps a unit → holders, and records which units were queried. */
function fakeLookup(table: Record<string, AssetHolder[]>) {
  const queried: string[] = [];
  return {
    queried,
    getAssetAddresses: (unit: string) => {
      queried.push(unit);
      return Promise.resolve(table[unit] ?? []);
    },
  };
}

describe('handle normalization & detection', () => {
  it('detects a $-prefixed handle attempt', () => {
    expect(looksLikeHandle('$alice')).toBe(true);
    expect(looksLikeHandle('  $alice  ')).toBe(true);
    expect(looksLikeHandle('addr_test1qq')).toBe(false);
    expect(looksLikeHandle('alice')).toBe(false);
  });

  it('strips $, lowercases, and accepts the ADA Handle charset', () => {
    expect(normalizeHandle('$Alice')).toBe('alice');
    expect(normalizeHandle('alice')).toBe('alice');
    expect(normalizeHandle('$a_b-c.d')).toBe('a_b-c.d');
    expect(normalizeHandle('$1234567890')).toBe('1234567890');
  });

  it('rejects invalid handles (empty, too long, bad chars, subhandles)', () => {
    expect(normalizeHandle('$')).toBeNull();
    expect(normalizeHandle('$' + 'a'.repeat(16))).toBeNull(); // > 15 bytes
    expect(normalizeHandle('$bad space')).toBeNull();
    expect(normalizeHandle('$emoji😀')).toBeNull();
    expect(normalizeHandle('$sub@root')).toBeNull(); // subhandle — out of scope
  });
});

describe('handleToUnits', () => {
  it('builds the legacy (CIP-25) and CIP-68 (222) units under the official policy', () => {
    const { cip68, legacy } = handleToUnits('boris');
    expect(legacy).toBe(HANDLE_POLICY_ID + hex('boris'));
    // 222 label prefix (000de140) + name hex.
    expect(cip68).toBe(HANDLE_POLICY_ID + '000de140' + hex('boris'));
  });
});

describe('resolveHandle', () => {
  const { cip68, legacy } = handleToUnits('boris');
  const ADDR = 'addr_test1qqboris0000000000000000000000000000000000000000000000000';

  it('rejects an invalid handle before any lookup', async () => {
    const lookup = fakeLookup({});
    await expect(resolveHandle('$bad space', lookup)).rejects.toBeInstanceOf(HandleError);
    expect(lookup.queried).toEqual([]); // never hit the network with garbage
  });

  it('prefers the CIP-68 (222) holder and returns it', async () => {
    const lookup = fakeLookup({ [cip68]: [{ address: ADDR, quantity: '1' }] });
    const r = await resolveHandle('$Boris', lookup);
    expect(r).toEqual({ handle: 'boris', address: ADDR });
    expect(lookup.queried[0]).toBe(cip68); // 222 tried first
  });

  it('falls back to the legacy unit when no CIP-68 holder exists', async () => {
    const lookup = fakeLookup({ [legacy]: [{ address: ADDR, quantity: '1' }] });
    const r = await resolveHandle('$boris', lookup);
    expect(r.address).toBe(ADDR);
    expect(lookup.queried).toEqual([cip68, legacy]); // tried 222, then legacy
  });

  it('throws (not minted) when no address holds either unit', async () => {
    const lookup = fakeLookup({});
    await expect(resolveHandle('$boris', lookup)).rejects.toThrow(/not minted/i);
  });

  it('rejects an ambiguous handle held by more than one address', async () => {
    const lookup = fakeLookup({
      [cip68]: [
        { address: ADDR, quantity: '1' },
        { address: ADDR + 'x', quantity: '1' },
      ],
    });
    await expect(resolveHandle('$boris', lookup)).rejects.toThrow(/ambiguous/i);
  });

  it('ignores zero-quantity / empty-address holder rows', async () => {
    const lookup = fakeLookup({
      [cip68]: [{ address: ADDR, quantity: '0' }],
      [legacy]: [{ address: ADDR, quantity: '1' }],
    });
    const r = await resolveHandle('$boris', lookup);
    expect(r.address).toBe(ADDR); // the 0-qty CIP-68 row is skipped → resolves via legacy
  });
});
