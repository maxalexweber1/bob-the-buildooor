import { describe, it, expect } from 'vitest';
import { UTxO, Value, Tx, TxWitnessSet, defaultProtocolParameters, defaultPreviewGenesisInfos } from '@harmoniclabs/buildooor';
import { mnemonicToRoot, deriveKey, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { buildSend, type BuildContext } from '../src/core/tx/build';
import { summarizeTx } from '../src/core/tx/summary';
import { signTxCbor, signTxWitnessSet } from '../src/background/signer';
import { toHex } from '../src/core/crypto/encoding';

const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
const ownAddr = baseAddress(root, 'testnet', 0, 0);
const RECIPIENT =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

// Real preview-ish params (buildooor's default utxoCostPerByte is unrealistically high).
const pp = { ...defaultProtocolParameters, utxoCostPerByte: 4310, txFeePerByte: 44, txFeeFixed: 155381 };

function ctxWith(lovelace: bigint): BuildContext {
  const utxo = new UTxO({ utxoRef: { id: 'aa'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(lovelace) } });
  return { protocolParameters: pp, genesisInfos: defaultPreviewGenesisInfos, utxos: [utxo], changeAddress: ownAddr };
}

describe('buildSend (T3.1)', () => {
  it('builds a balanced ADA payment (out + change + fee == input)', () => {
    const tx = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n });
    expect(tx.body.outputs.length).toBe(2);
    const out0 = tx.body.outputs[0];
    expect(out0?.address.toString()).toBe(RECIPIENT);
    expect(out0?.value.lovelaces).toBe(3_000_000n);
    const total = (tx.body.outputs[0]?.value.lovelaces ?? 0n) + (tx.body.outputs[1]?.value.lovelaces ?? 0n) + tx.body.fee;
    expect(total).toBe(10_000_000n);
  });

  it('rejects a zero amount', () => {
    expect(() => buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 0n })).toThrow(/greater than zero/);
  });

  it('rejects insufficient funds', () => {
    expect(() => buildSend(ctxWith(2_000_000n), { toAddress: RECIPIENT, lovelace: 100_000_000n })).toThrow();
  });

  it('rejects a recipient on the wrong network (mainnet address, testnet wallet)', () => {
    const mainnetAddr = baseAddress(root, 'mainnet', 0, 0);
    expect(() =>
      buildSend(ctxWith(10_000_000n), { toAddress: mainnetAddr, lovelace: 3_000_000n }),
    ).toThrow(/network/);
  });

  it('attaches a CIP-20 memo that decodes back in the summary (T4.12b)', () => {
    const ctx = ctxWith(10_000_000n);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n }, { memo: 'thanks for lunch' });
    expect(summarizeTx(tx, ctx.utxos, new Set([ownAddr])).message).toEqual({
      lines: ['thanks for lunch'],
      encrypted: false,
    });
  });

  it('splits a long memo into ≤64-byte CIP-20 lines', () => {
    const ctx = ctxWith(10_000_000n);
    const long = 'x'.repeat(120);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n }, { memo: long });
    const lines = summarizeTx(tx, ctx.utxos, new Set([ownAddr])).message?.lines ?? [];
    expect(lines.length).toBe(2);
    expect(lines.join('')).toBe(long);
  });

  it('rejects a memo over the byte cap', () => {
    expect(() =>
      buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n }, { memo: 'z'.repeat(300) }),
    ).toThrow(/memo too long/);
  });

  it('omits aux data when no memo is given (no false metadata flag)', () => {
    const ctx = ctxWith(10_000_000n);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const summary = summarizeTx(tx, ctx.utxos, new Set([ownAddr]));
    expect(summary.message).toBeUndefined();
    expect(summary.flags.metadata).toBe(false);
  });
});

describe('Conway governance decode end-to-end (T6.2, patched ledger-ts)', () => {
  // A real buildooor-built tx with a Conway vote-delegation cert (delegate voting power to Always
  // Abstain). Parsing this needs the TxBody Certificate dual-class repoint in our patch — on the
  // unpatched lib `Tx.fromCbor` throws / the cert can't round-trip. Proves the patch + the decoder.
  const GOV_TX_HEX =
    '84a50081825820aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa00018' +
    '1a20058390032b3270fd1561cec0aa24b4aec6850cd0196486033e3dd849945c319ace819f4175c9c04' +
    '9239a91c9c07ece20bf7e7485d7cd414e721a5fc011a0095f81f021a00029e6104818309820058' +
    '1c1111111111111111111111111111111111111111111111111111111181020f00a0f5f6';

  it('parses a Conway vote-delegation tx and decodes the certificate in the summary', () => {
    const tx = Tx.fromCbor(GOV_TX_HEX);
    const summary = summarizeTx(tx, [], new Set());
    expect(summary.certificates).toEqual([
      { type: 'VoteDeleg', description: 'Delegate voting power to Always Abstain' },
    ]);
    expect(summary.flags.certificates).toBe(true);
  });
});

describe('summarizeTx (T3.3 — decode for approval)', () => {
  it('shows recipient + change (own) + fee, with resolved inputs', () => {
    const ctx = ctxWith(10_000_000n);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const summary = summarizeTx(tx, ctx.utxos, new Set([ownAddr]));

    expect(summary.unresolvedInputs).toBe(0);
    expect(summary.inputs[0]?.address).toBe(ownAddr);
    expect(summary.inputs[0]?.value.lovelace).toBe('10000000');

    const recipient = summary.outputs.find((o) => !o.isOwn);
    const change = summary.outputs.find((o) => o.isOwn);
    expect(recipient?.address).toBe(RECIPIENT);
    expect(recipient?.value.lovelace).toBe('3000000');
    expect(change?.address).toBe(ownAddr);
    expect(summary.fee).toBe(tx.body.fee.toString());
  });

  it('flags are all false for a plain ADA payment (no mint/cert/gov)', () => {
    const ctx = ctxWith(10_000_000n);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const { flags } = summarizeTx(tx, ctx.utxos, new Set([ownAddr]));
    expect(Object.values(flags).every((v) => v === false)).toBe(true);
  });
});

describe('signTxCbor (T3.2)', () => {
  it('adds a vkey witness for the input owner key', () => {
    const ctx = ctxWith(10_000_000n);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const payKey = deriveKey(root, 0, Role.External, 0); // owns ownAddr
    const signed = signTxCbor(toHex(tx.toCborBytes()), [payKey]);
    expect(Tx.fromCbor(signed).witnesses.vkeyWitnesses?.length).toBe(1);
  });

  it('signTxWitnessSet (CIP-30) returns only the witness set with our vkey witness', () => {
    const ctx = ctxWith(10_000_000n);
    const tx = buildSend(ctx, { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const payKey = deriveKey(root, 0, Role.External, 0);
    const wsHex = signTxWitnessSet(toHex(tx.toCborBytes()), [payKey]);
    expect(TxWitnessSet.fromCbor(wsHex).vkeyWitnesses?.length).toBe(1);
  });
});
