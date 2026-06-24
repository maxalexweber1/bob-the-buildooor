import { describe, it, expect } from 'vitest';
import { UTxO, Value } from '@harmoniclabs/buildooor';
import { selectCollateral } from '../src/core/tx/collateral';

const ADDR =
  'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const ASSET = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f534e4654';

function utxo(i: number, units: { unit: string; quantity: string }[]): UTxO {
  return new UTxO({ utxoRef: { id: 'aa'.repeat(32), index: i }, resolved: { address: ADDR, value: Value.fromUnits(units) } });
}

describe('selectCollateral (T5.2)', () => {
  it('picks the SMALLEST ADA-only UTxO ≥ minimum (never a big one)', () => {
    const utxos = [
      utxo(0, [{ unit: 'lovelace', quantity: '50000000' }]), // big ADA-only
      utxo(1, [{ unit: 'lovelace', quantity: '6000000' }]), // small ADA-only ≥ 5
      utxo(2, [{ unit: 'lovelace', quantity: '8000000' }, { unit: ASSET, quantity: '1' }]), // has asset → excluded
    ];
    expect(selectCollateral(utxos, 5_000_000n)?.utxoRef.index).toBe(1);
  });

  it('excludes UTxOs carrying native assets (collateral must be ADA-only)', () => {
    const utxos = [utxo(0, [{ unit: 'lovelace', quantity: '10000000' }, { unit: ASSET, quantity: '1' }])];
    expect(selectCollateral(utxos, 5_000_000n)).toBeNull();
  });

  it('returns null when nothing meets the minimum', () => {
    const utxos = [utxo(0, [{ unit: 'lovelace', quantity: '2000000' }])];
    expect(selectCollateral(utxos, 5_000_000n)).toBeNull();
  });
});
