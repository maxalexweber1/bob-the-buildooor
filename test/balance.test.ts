import { describe, it, expect } from 'vitest';
import { UTxO, Value } from '@harmoniclabs/buildooor';
import { aggregateBalance } from '../src/core/balance';

const ADDR =
  'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const POLICY = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f';
const SNFT = '534e4654'; // "SNFT" — printable ASCII
const NONPRINT = 'ff00'; // invalid UTF-8

function utxo(txHash: string, index: number, units: { unit: string; quantity: string }[]): UTxO {
  return new UTxO({ utxoRef: { id: txHash, index }, resolved: { address: ADDR, value: Value.fromUnits(units) } });
}

const TX = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';

describe('aggregateBalance (T2.5)', () => {
  it('sums lovelace across UTxOs', () => {
    const b = aggregateBalance([
      utxo(TX, 0, [{ unit: 'lovelace', quantity: '4250000' }]),
      utxo(TX, 1, [{ unit: 'lovelace', quantity: '1750000' }]),
    ]);
    expect(b.lovelace).toBe('6000000');
    expect(b.assets).toEqual([]);
  });

  it('aggregates a native asset spread across UTxOs and decodes a printable name', () => {
    const b = aggregateBalance([
      utxo(TX, 0, [{ unit: 'lovelace', quantity: '2000000' }, { unit: POLICY + SNFT, quantity: '7' }]),
      utxo(TX, 1, [{ unit: POLICY + SNFT, quantity: '5' }]),
    ]);
    expect(b.lovelace).toBe('2000000');
    expect(b.assets).toHaveLength(1);
    expect(b.assets[0]).toMatchObject({
      unit: POLICY + SNFT,
      policyId: POLICY,
      assetNameHex: SNFT,
      assetNameUtf8: 'SNFT',
      quantity: '12',
    });
  });

  it('leaves a non-printable asset name undecoded (hex only)', () => {
    const b = aggregateBalance([utxo(TX, 0, [{ unit: 'lovelace', quantity: '2000000' }, { unit: POLICY + NONPRINT, quantity: '1' }])]);
    expect(b.assets[0]?.assetNameUtf8).toBeUndefined();
    expect(b.assets[0]?.assetNameHex).toBe(NONPRINT);
  });

  it('strips a CIP-67 prefix and decodes the CIP-68 token name + label', () => {
    const CIP68_NFT = '000de140' + Buffer.from('Test', 'utf8').toString('hex'); // label 222 + "Test"
    const b = aggregateBalance([utxo(TX, 0, [{ unit: 'lovelace', quantity: '2000000' }, { unit: POLICY + CIP68_NFT, quantity: '1' }])]);
    expect(b.assets[0]).toMatchObject({
      unit: POLICY + CIP68_NFT,
      assetNameHex: CIP68_NFT, // full on-chain name retained
      assetNameUtf8: 'Test', // readable name from the content after the prefix
      cip67Label: 222,
    });
  });

  it('does not set cip67Label for an ordinary (non-CIP-68) asset name', () => {
    const b = aggregateBalance([utxo(TX, 0, [{ unit: 'lovelace', quantity: '2000000' }, { unit: POLICY + SNFT, quantity: '1' }])]);
    expect(b.assets[0]?.cip67Label).toBeUndefined();
    expect(b.assets[0]?.assetNameUtf8).toBe('SNFT');
  });

  it('is empty for no UTxOs', () => {
    expect(aggregateBalance([])).toEqual({ lovelace: '0', assets: [] });
  });
});
