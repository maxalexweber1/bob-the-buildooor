// Security review #2: mint/burn and reward withdrawals must be DECODED for the approval UI, not just
// flagged. These pin the pure decoders (the full summarizeTx is exercised via the tx build tests).
// Collateral / collateral-return / total-collateral / reference inputs must surface in the
// summary — tested against a real CBOR round-trip (the dApp signTx path).
import { describe, it, expect } from 'vitest';
import { decodeMint, decodeWithdrawals, summarizeTx } from '../src/core/tx/summary';
import { Tx, TxBody, TxWitnessSet, TxOut, UTxO, Value, Address } from '@harmoniclabs/buildooor';
import { mnemonicToRoot } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { toHex } from '../src/core/crypto/encoding';

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

const OWN = baseAddress(mnemonicToRoot('abandon '.repeat(23) + 'art'), 'testnet', 0, 0);
const FOREIGN =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

function mkUtxo(idByte: string, index: number, address: string, lovelace: bigint): UTxO {
  return new UTxO({
    utxoRef: { id: idByte.repeat(32), index },
    resolved: { address, value: Value.lovelaces(lovelace) },
  });
}

/** A Plutus-shaped tx (collateral + return + total + reference input), round-tripped through CBOR
 *  exactly like a dApp-provided tx (the fields must survive parse, not just construction). */
function collateralTx() {
  const spend = mkUtxo('aa', 0, FOREIGN, 10_000_000n);
  const coll = mkUtxo('bb', 1, OWN, 5_000_000n);
  const refIn = mkUtxo('cc', 2, FOREIGN, 1_000_000n);
  const body = new TxBody({
    inputs: [spend],
    outputs: [new TxOut({ address: Address.fromString(FOREIGN), value: Value.lovelaces(9_800_000n) })],
    fee: 200_000n,
    collateralInputs: [coll],
    totCollateral: 3_000_000n,
    collateralReturn: new TxOut({ address: Address.fromString(OWN), value: Value.lovelaces(2_000_000n) }),
    refInputs: [refIn],
  });
  const tx = new Tx({ body, witnesses: new TxWitnessSet({}) });
  return { tx: Tx.fromCbor(toHex(tx.toCborBytes())), spend, coll, refIn };
}

describe('summarizeTx — collateral & reference inputs', () => {
  it('shows a wallet-owned collateral input, its value, total collateral and collateral return', () => {
    const { tx, spend, coll } = collateralTx();
    const s = summarizeTx(tx, [spend, coll], new Set([OWN]));
    expect(s.collateralInputs).toHaveLength(1);
    expect(s.collateralInputs[0]?.address).toBe(OWN);
    expect(s.collateralInputs[0]?.isOwn).toBe(true);
    expect(s.collateralInputs[0]?.value.lovelace).toBe('5000000');
    expect(s.unresolvedCollateralInputs).toBe(0);
    expect(s.totalCollateral).toBe('3000000');
    expect(s.collateralReturn?.address).toBe(OWN);
    expect(s.collateralReturn?.isOwn).toBe(true);
    expect(s.collateralReturn?.value.lovelace).toBe('2000000');
  });

  it('a foreign collateral input is shown as not owned', () => {
    const { tx, spend, coll } = collateralTx();
    const s = summarizeTx(tx, [spend, coll], new Set<string>());
    expect(s.collateralInputs[0]?.isOwn).toBe(false);
    expect(s.collateralReturn?.isOwn).toBe(false);
  });

  it('an unresolvable collateral input is counted, never silently dropped', () => {
    const { tx, spend } = collateralTx();
    const s = summarizeTx(tx, [spend], new Set([OWN]));
    expect(s.collateralInputs).toHaveLength(0);
    expect(s.unresolvedCollateralInputs).toBe(1);
  });

  it('reference inputs surface as txHash#index refs (read-only, not spent)', () => {
    const { tx, spend, coll } = collateralTx();
    const s = summarizeTx(tx, [spend, coll], new Set([OWN]));
    expect(s.referenceInputs).toHaveLength(1);
    expect(s.referenceInputs[0]).toContain('cc'.repeat(32));
    expect(s.referenceInputs[0]).toContain('2');
    // reference inputs must NOT count as spending inputs
    expect(s.inputs).toHaveLength(1);
  });

  it('a plain tx reports no collateral and no reference inputs', () => {
    const spend = mkUtxo('aa', 0, OWN, 10_000_000n);
    const body = new TxBody({
      inputs: [spend],
      outputs: [new TxOut({ address: Address.fromString(FOREIGN), value: Value.lovelaces(9_800_000n) })],
      fee: 200_000n,
    });
    const tx = new Tx({ body, witnesses: new TxWitnessSet({}) });
    const s = summarizeTx(Tx.fromCbor(toHex(tx.toCborBytes())), [spend], new Set([OWN]));
    expect(s.collateralInputs).toEqual([]);
    expect(s.unresolvedCollateralInputs).toBe(0);
    expect(s.collateralReturn).toBeUndefined();
    expect(s.totalCollateral).toBeUndefined();
    expect(s.referenceInputs).toEqual([]);
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
