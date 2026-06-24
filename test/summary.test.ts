// Security review #2: mint/burn and reward withdrawals must be DECODED for the approval UI, not just
// flagged. These pin the pure decoders (the full summarizeTx is exercised via the tx build tests).
import { describe, it, expect } from 'vitest';
import { decodeMint, decodeWithdrawals } from '../src/core/tx/summary';

const POLICY = 'a'.repeat(56);
const NAME_HEX = Buffer.from('TestCoin', 'utf8').toString('hex');

describe('decodeMint (review #2)', () => {
  it('returns [] when there is no mint', () => {
    expect(decodeMint(undefined)).toEqual([]);
  });

  it('decodes a positive mint with policy + name', () => {
    const mint = { toJson: () => ({ [POLICY]: { [NAME_HEX]: '100' } }) };
    const out = decodeMint(mint);
    expect(out).toHaveLength(1);
    expect(out[0]?.policyId).toBe(POLICY);
    expect(out[0]?.assetNameUtf8).toBe('TestCoin');
    expect(out[0]?.quantity).toBe('100');
  });

  it('preserves a negative quantity (a burn)', () => {
    const mint = { toJson: () => ({ [POLICY]: { [NAME_HEX]: '-42' } }) };
    const out = decodeMint(mint);
    expect(out[0]?.quantity).toBe('-42');
  });
});

describe('decodeWithdrawals (review #2)', () => {
  it('returns [] when there are no withdrawals', () => {
    expect(decodeWithdrawals(undefined)).toEqual([]);
  });

  it('decodes each reward address → amount', () => {
    const w = {
      toJson: () => ({
        stake_test1aaa: '1500000',
        stake_test1bbb: '0',
      }),
    };
    expect(decodeWithdrawals(w)).toEqual([
      { rewardAddress: 'stake_test1aaa', amount: '1500000' },
      { rewardAddress: 'stake_test1bbb', amount: '0' },
    ]);
  });
});
