import { describe, it, expect } from 'vitest';
import { UTxO, Value } from '@harmoniclabs/buildooor';
import { selectUtxos, paginate } from '../src/background/cip30/handlers';
import { PaginateError } from '../src/shared/errors';
import { toHex } from '../src/core/crypto/encoding';

const ADDR =
  'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const ASSET = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e4654';

function utxo(index: number, units: { unit: string; quantity: string }[]): UTxO {
  return new UTxO({ utxoRef: { id: 'aa'.repeat(32), index }, resolved: { address: ADDR, value: Value.fromUnits(units) } });
}
const amountHex = (units: { unit: string; quantity: string }[]) => toHex(Value.fromUnits(units).toCborBytes());

describe('selectUtxos (getUtxos amount coverage)', () => {
  it('returns all when no amount given', () => {
    const all = [utxo(0, [{ unit: 'lovelace', quantity: '1000000' }])];
    expect(selectUtxos(all, undefined)).toBe(all);
  });

  it('covers a lovelace target with the fewest leading UTxOs', () => {
    const all = [utxo(0, [{ unit: 'lovelace', quantity: '2000000' }]), utxo(1, [{ unit: 'lovelace', quantity: '2000000' }])];
    const picked = selectUtxos(all, amountHex([{ unit: 'lovelace', quantity: '3000000' }]));
    expect(picked).toHaveLength(2);
  });

  it('covers a MULTI-ASSET target (ADA + native asset)', () => {
    const all = [
      utxo(0, [{ unit: 'lovelace', quantity: '5000000' }]), // ADA only
      utxo(1, [{ unit: 'lovelace', quantity: '2000000' }, { unit: ASSET, quantity: '10' }]), // has the asset
    ];
    const picked = selectUtxos(all, amountHex([{ unit: 'lovelace', quantity: '1000000' }, { unit: ASSET, quantity: '3' }]));
    // Must include the asset-bearing UTxO (index 1).
    expect(picked?.some((u) => u.utxoRef.index === 1)).toBe(true);
  });

  it('returns null when the amount is unattainable', () => {
    const all = [utxo(0, [{ unit: 'lovelace', quantity: '2000000' }])];
    expect(selectUtxos(all, amountHex([{ unit: 'lovelace', quantity: '100000000' }]))).toBeNull();
  });
});

describe('paginate (CIP-30 PaginateError)', () => {
  const items = [0, 1, 2, 3, 4];
  it('returns everything when no paginate arg', () => {
    expect(paginate(items)).toEqual(items);
  });
  it('slices a page in range', () => {
    expect(paginate(items, { page: 1, limit: 2 })).toEqual([2, 3]);
  });
  it('throws PaginateError with maxSize when out of range', () => {
    try {
      paginate(items, { page: 3, limit: 2 }); // maxSize = ceil(5/2) = 3, page 3 invalid
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PaginateError);
      expect((e as PaginateError).maxSize).toBe(3);
    }
  });
});
