import { describe, it, expect } from 'vitest';
import { Tx } from '@harmoniclabs/buildooor';
import { decodeTxMessage } from '../src/core/tx/txMessage';

// Regression guard for the patched @harmoniclabs/cardano-ledger-ts (patches/…+0.5.1.patch):
// AuxiliaryData.fromCborObj in 0.5.1 wrongly rejects metadata-ONLY Conway aux_data (it required all
// optional script arrays to be present), so Tx.fromCbor threw "Invalid CBOR format for AuxiliaryData"
// for ANY tx carrying just a CIP-20 (label 674) memo — the most common metadata shape. That blocked
// us from even PARSING (and therefore signing) such a dApp tx. The patch relaxes the precondition.
//
// This fixture is a real buildooor-built tx with a metadata-only 674 memo. If the patch is NOT applied
// (e.g. a fresh `npm install` without `npm run postinstall`, which ignore-scripts blocks), Tx.fromCbor
// throws here — turning a silent, env-dependent signing failure into a loud test failure.
const MEMO_TX_HEX =
  '84a50081825820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000182a2' +
  '0058390032b3270fd1561cec0aa24b4aec6850cd0196486033e3dd849945c319ace819f4175c9c049239a9' +
  '1c9c07ece20bf7e7485d7cd414e721a5fc011a001e8480a20058390032b3270fd1561cec0aa24b4aec6850' +
  'cd0196486033e3dd849945c319ace819f4175c9c049239a91c9c07ece20bf7e7485d7cd414e721a5fc011a' +
  '007773f7021a00029e090758206b0ff9ce72460daaf2a0506c2470ef8e450f572a85dd252e7ea96500c63d' +
  '92460f00a0f5d90103a100a11902a2a1636d7367826b676d2066726f6d20626f626b7365636f6e64206c69' +
  '6e65';

describe('cardano-ledger-ts patch: metadata-only aux_data parses (PR #19 / fork bc95c39)', () => {
  it('Tx.fromCbor accepts a metadata-only CIP-20 memo tx (would throw unpatched)', () => {
    expect(() => Tx.fromCbor(MEMO_TX_HEX)).not.toThrow();
  });

  it('the decoded 674 memo round-trips through our CIP-20 decoder', () => {
    const tx = Tx.fromCbor(MEMO_TX_HEX);
    const msg = decodeTxMessage(tx.auxiliaryData?.metadata?.toJson());
    expect(msg).toEqual({ lines: ['gm from bob', 'second line'], encrypted: false });
  });
});
