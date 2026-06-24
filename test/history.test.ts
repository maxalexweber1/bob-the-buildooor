// Transaction-history net-delta logic: received / sent / self, with token movement.
import { describe, it, expect } from 'vitest';
import { computeHistoryEntry, type TxDetailView } from '../src/core/tx/history';

const ME = 'addr_test1_me';
const ME2 = 'addr_test1_me_change';
const OTHER = 'addr_test1_other';
const own = new Set([ME, ME2]);
const ASSET = 'a'.repeat(56) + Buffer.from('TOK', 'utf8').toString('hex');

const lovelace = (q: string) => [{ unit: 'lovelace', quantity: q }];

describe('computeHistoryEntry', () => {
  it('classifies a pure receive (no own inputs) as "in" with positive net', () => {
    const detail: TxDetailView = {
      txHash: 'tx1',
      inputs: [{ address: OTHER, amount: lovelace('10000000') }],
      outputs: [{ address: ME, amount: lovelace('4000000') }, { address: OTHER, amount: lovelace('5800000') }],
      fee: '200000',
    };
    const e = computeHistoryEntry(detail, own, 1700000000);
    expect(e.direction).toBe('in');
    expect(e.netLovelace).toBe('4000000');
    expect(e.counterparties).toEqual([OTHER]);
    expect(e.fee).toBe('200000');
  });

  it('classifies a spend (own inputs, net negative) as "out"', () => {
    const detail: TxDetailView = {
      txHash: 'tx2',
      inputs: [{ address: ME, amount: lovelace('10000000') }],
      outputs: [{ address: OTHER, amount: lovelace('3000000') }, { address: ME2, amount: lovelace('6800000') }],
      fee: '200000',
    };
    const e = computeHistoryEntry(detail, own, 1700000100);
    expect(e.direction).toBe('out');
    expect(e.netLovelace).toBe('-3200000'); // 6.8 change - 10 in = -3.2 (incl fee)
    expect(e.counterparties).toEqual([OTHER]); // own change excluded
  });

  it('classifies a self-transfer (own inputs, net >= 0) as "self"', () => {
    const detail: TxDetailView = {
      txHash: 'tx3',
      inputs: [{ address: ME, amount: lovelace('5000000') }],
      outputs: [{ address: ME2, amount: lovelace('4800000') }],
      fee: '200000',
    };
    const e = computeHistoryEntry(detail, own, 1700000200);
    expect(e.direction).toBe('self');
  });

  it('reports net token movement (signed) and drops net-zero tokens', () => {
    const detail: TxDetailView = {
      txHash: 'tx4',
      inputs: [{ address: ME, amount: [{ unit: 'lovelace', quantity: '5000000' }, { unit: ASSET, quantity: '10' }] }],
      outputs: [
        { address: OTHER, amount: [{ unit: 'lovelace', quantity: '1500000' }, { unit: ASSET, quantity: '3' }] },
        { address: ME2, amount: [{ unit: 'lovelace', quantity: '3300000' }, { unit: ASSET, quantity: '7' }] },
      ],
      fee: '200000',
    };
    const e = computeHistoryEntry(detail, own, 1700000300);
    // 7 (own out) - 10 (own in) = -3 net tokens left the wallet
    expect(e.netAssets).toHaveLength(1);
    expect(e.netAssets[0]?.quantity).toBe('-3');
    expect(e.netAssets[0]?.assetNameUtf8).toBe('TOK');
  });
});
