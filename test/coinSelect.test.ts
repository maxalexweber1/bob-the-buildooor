import { describe, it, expect } from 'vitest';
import { UTxO, Value } from '@harmoniclabs/buildooor';
import { selectInputs } from '../src/core/tx/coinSelect';

const ADDR =
  'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const ASSET = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e4654';

function utxo(i: number, units: { unit: string; quantity: string }[]): UTxO {
  return new UTxO({ utxoRef: { id: 'aa'.repeat(32), index: i }, resolved: { address: ADDR, value: Value.fromUnits(units) } });
}

describe('selectInputs (own coin selection; replaces broken keepRelevant)', () => {
  it('picks the FEWEST inputs (largest-first), not every UTxO', () => {
    const utxos = [
      utxo(0, [{ unit: 'lovelace', quantity: '2000000' }]),
      utxo(1, [{ unit: 'lovelace', quantity: '6000000000' }]), // one big UTxO covers it
      utxo(2, [{ unit: 'lovelace', quantity: '3000000' }]),
    ];
    const picked = selectInputs(utxos, { lovelace: 12_000_000n }, 2_000_000n);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.utxoRef.index).toBe(1); // the big one — NOT all three
  });

  it('covers a native-asset target', () => {
    const utxos = [
      utxo(0, [{ unit: 'lovelace', quantity: '5000000' }]), // ADA only
      utxo(1, [{ unit: 'lovelace', quantity: '2000000' }, { unit: ASSET, quantity: '10' }]),
    ];
    const picked = selectInputs(utxos, { lovelace: 1_000_000n, assets: new Map([[ASSET, 3n]]) }, 1_000_000n);
    expect(picked.some((u) => u.utxoRef.index === 1)).toBe(true); // must include the asset UTxO
  });

  it('throws on insufficient funds', () => {
    const utxos = [utxo(0, [{ unit: 'lovelace', quantity: '2000000' }])];
    expect(() => selectInputs(utxos, { lovelace: 100_000_000n })).toThrow(/insufficient/);
  });

  it('scales headroom with input count — many small UTxOs keep a per-input margin (review #-low)', () => {
    // Ten 2-ADA UTxOs; need 12 ADA + 2 ADA base buffer + 0.1 ADA/input. Selection must cover the
    // rising bar, so the picked sum comfortably exceeds target + base buffer (margin for the fee).
    const utxos = Array.from({ length: 10 }, (_, i) => utxo(i, [{ unit: 'lovelace', quantity: '2000000' }]));
    const picked = selectInputs(utxos, { lovelace: 12_000_000n }, 2_000_000n);
    const sum = picked.reduce((acc, u) => acc + u.resolved.value.lovelaces, 0n);
    const dynamicNeed = 12_000_000n + 2_000_000n + 100_000n * BigInt(picked.length);
    expect(sum).toBeGreaterThanOrEqual(dynamicNeed);
  });
});
