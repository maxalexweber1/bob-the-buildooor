// Hardware-wallet path (EXECUTION_PLAN T6.3) — device-free unit tests. The Ledger is simulated with
// the SAME seed's XPrv: the xpub account must derive identical addresses to the hot-wallet path, and
// a "device witness" is just an XPrv signature over the body hash — so verification, tampering and
// path-mismatch behavior are all testable without hardware.
import { describe, it, expect } from 'vitest';
import {
  Address,
  Tx,
  TxBody,
  TxWitnessSet,
  UTxO,
  Value,
  defaultProtocolParameters,
  defaultPreviewGenesisInfos,
} from '@harmoniclabs/buildooor';
import { mnemonicToRoot, deriveAccountKey, deriveKey, Role } from '../src/core/keys';
import { accountKeys, baseAddress, baseAddressFrom } from '../src/core/address';
import { buildSend, type BuildContext } from '../src/core/tx/build';
import {
  hwAccountKeys,
  hwBaseAddress,
  hwPublicKey,
  parseAccountXpub,
  verifyHwSignature,
} from '../src/core/hw/xpubAccount';
import {
  HARDENED,
  HwUnsupportedError,
  HwWitnessError,
  applyHwWitnesses,
  ledgerNetwork,
  mapTxForLedger,
  signerPath,
  type HwWitness,
} from '../src/core/hw/ledgerTx';
import { toHex, fromHex } from '../src/core/crypto/encoding';

const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
const ACCOUNT_XPUB = toHex(deriveAccountKey(root, 0).public().bytes); // what the device would export
const RECIPIENT =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

const keys = hwAccountKeys(ACCOUNT_XPUB);
const hwAddr0 = hwBaseAddress(keys, 'testnet', 0);

const pp = { ...defaultProtocolParameters, utxoCostPerByte: 4310, txFeePerByte: 44, txFeeFixed: 155381 };

function ctxWith(lovelace: bigint): BuildContext {
  const utxo = new UTxO({
    utxoRef: { id: 'aa'.repeat(32), index: 0 },
    resolved: { address: hwAddr0, value: Value.lovelaces(lovelace) },
  });
  return { protocolParameters: pp, genesisInfos: defaultPreviewGenesisInfos, utxos: [utxo], changeAddress: hwAddr0 };
}

function mapCtx() {
  return {
    network: 'preview' as const,
    inputOwners: new Map([[`${'aa'.repeat(32)}#0`, { role: Role.External, index: 0 }]]),
    ownedAddresses: new Map([[hwAddr0, { role: Role.External, index: 0 }]]),
  };
}

/** Simulate the device: sign the tx body hash with the real derived private key. */
function deviceWitness(tx: Tx, role: number, index: number): HwWitness {
  const bodyHash = fromHex(tx.body.hash.toString());
  const { signature } = deriveKey(root, 0, role, index).sign(bodyHash);
  return { path: signerPath({ role, index }), witnessSignatureHex: toHex(signature) };
}

// ---- xpub account derivation --------------------------------------------------------------------

describe('hwAccountKeys / hwBaseAddress (watch-only derivation)', () => {
  it('derives the SAME addresses from the xpub as the hot-wallet path derives from the XPrv', () => {
    const hot = accountKeys(root, 0);
    for (const role of [Role.External, Role.Internal] as const) {
      for (const index of [0, 1, 7]) {
        expect(hwBaseAddress(keys, 'testnet', index, role)).toBe(baseAddressFrom(hot, 'testnet', index, role));
      }
    }
    expect(hwBaseAddress(keys, 'mainnet', 0)).toBe(baseAddress(root, 'mainnet', 0, 0));
    expect(toHex(keys.stakeKeyHash)).toBe(toHex(hot.stakeKeyHash));
  });

  it('soft-derives the same public keys as the private path', () => {
    expect(toHex(hwPublicKey(keys, Role.External, 3))).toBe(
      toHex(deriveKey(root, 0, Role.External, 3).public().toPubKeyBytes()),
    );
  });

  it('rejects malformed xpubs (wrong length / non-hex)', () => {
    expect(() => parseAccountXpub('ab'.repeat(32))).toThrow(/xpub/);
    expect(() => parseAccountXpub('zz'.repeat(64))).toThrow(/xpub/);
    expect(() => parseAccountXpub('')).toThrow(/xpub/);
  });

  it('verifies (and rejects) signatures against soft-derived keys', () => {
    const msg = new Uint8Array(32).fill(7);
    const { signature } = deriveKey(root, 0, Role.External, 0).sign(msg);
    expect(verifyHwSignature(keys, Role.External, 0, msg, signature)).toBe(true);
    expect(verifyHwSignature(keys, Role.External, 1, msg, signature)).toBe(false); // wrong key
    const tampered = new Uint8Array(signature);
    const first = tampered[0] ?? 0;
    tampered[0] = first ^ 0xff;
    expect(verifyHwSignature(keys, Role.External, 0, msg, tampered)).toBe(false);
  });
});

// ---- tx → Ledger payload mapping ----------------------------------------------------------------

describe('mapTxForLedger', () => {
  it('maps a plain send: input path, third-party + device-owned outputs, fee, network', () => {
    const tx = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const { payload, signers } = mapTxForLedger(tx, mapCtx());

    expect(payload.network).toEqual(ledgerNetwork('preview'));
    expect(payload.network.networkId).toBe(0);
    expect(payload.inputs).toEqual([
      { txHashHex: 'aa'.repeat(32), outputIndex: 0, path: [1852 + HARDENED, 1815 + HARDENED, HARDENED, 0, 0] },
    ]);

    const [toOut, changeOut] = payload.outputs;
    expect(toOut?.destination).toEqual({
      kind: 'third_party',
      addressHex: toHex(new Uint8Array(Address.fromString(RECIPIENT).toBytes())),
      addressBech32: RECIPIENT, // Trezor consumes the bech32 form, Ledger the hex bytes
    });
    expect(toOut?.amount).toBe('3000000');
    expect(changeOut?.destination).toEqual({
      kind: 'device_owned',
      spendingPath: [1852 + HARDENED, 1815 + HARDENED, HARDENED, 0, 0],
      stakingPath: [1852 + HARDENED, 1815 + HARDENED, HARDENED, 2, 0],
    });

    expect(payload.fee).toBe(tx.body.fee.toString());
    expect(signers).toEqual([{ role: Role.External, index: 0 }]);
  });

  it('carries the auxiliary-data hash for a CIP-20 memo tx', () => {
    const tx = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n }, { memo: 'hi' });
    const { payload } = mapTxForLedger(tx, mapCtx());
    expect(payload.auxDataHashHex).toBe(tx.body.auxDataHash?.toString());
  });

  it('rejects an input the account does not own (cannot be witnessed by this device)', () => {
    const tx = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n });
    expect(() => mapTxForLedger(tx, { ...mapCtx(), inputOwners: new Map() })).toThrow(HwUnsupportedError);
  });

  it('rejects unsupported body features by name instead of silently dropping them', () => {
    const base = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n });
    const withRequiredSigners = new Tx({
      body: new TxBody({
        inputs: base.body.inputs,
        outputs: base.body.outputs,
        fee: base.body.fee,
        requiredSigners: [new Uint8Array(28).fill(1)],
      }),
      witnesses: new TxWitnessSet({}),
    });
    expect(() => mapTxForLedger(withRequiredSigners, mapCtx())).toThrow(/required signers/);
  });
});

// ---- device witness verification ----------------------------------------------------------------

describe('applyHwWitnesses (trust-no-device-output gate)', () => {
  const expected = [{ role: Role.External, index: 0 }];

  function freshTx(): Tx {
    return buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 3_000_000n });
  }

  it('accepts a valid witness and produces a parseable signed tx', () => {
    const tx = freshTx();
    const wit = deviceWitness(tx, Role.External, 0);
    applyHwWitnesses(tx, [wit], tx.body.hash.toString(), keys, expected);
    expect(tx.witnesses.vkeyWitnesses?.length).toBe(1);
    // The signed tx round-trips through CBOR (what would be submitted).
    expect(() => Tx.fromCbor(toHex(tx.toCborBytes()))).not.toThrow();
  });

  it('rejects a device-reported tx hash that differs from ours (serialization drift)', () => {
    const tx = freshTx();
    const wit = deviceWitness(tx, Role.External, 0);
    expect(() => applyHwWitnesses(tx, [wit], 'bb'.repeat(32), keys, expected)).toThrow(/hash mismatch/);
  });

  it('rejects a tampered signature', () => {
    const tx = freshTx();
    const wit = deviceWitness(tx, Role.External, 0);
    const sig = wit.witnessSignatureHex;
    const tampered = (sig.startsWith('0') ? '1' : '0') + sig.slice(1);
    expect(() =>
      applyHwWitnesses(tx, [{ ...wit, witnessSignatureHex: tampered }], tx.body.hash.toString(), keys, expected),
    ).toThrow(HwWitnessError);
  });

  it('rejects a witness for the wrong derivation path', () => {
    const tx = freshTx();
    const wrongPath = { ...deviceWitness(tx, Role.External, 0), path: signerPath({ role: Role.External, index: 1 }) };
    expect(() => applyHwWitnesses(tx, [wrongPath], tx.body.hash.toString(), keys, expected)).toThrow(/missing witness/);
  });

  it('rejects missing or extra witnesses (exact signer coverage required)', () => {
    const tx = freshTx();
    expect(() => applyHwWitnesses(tx, [], tx.body.hash.toString(), keys, expected)).toThrow(/expected 1 witness/);
    const wit = deviceWitness(tx, Role.External, 0);
    expect(() =>
      applyHwWitnesses(tx, [wit, wit], tx.body.hash.toString(), keys, expected),
    ).toThrow(/expected 1 witness/);
  });

  it('rejects a witness signed over a DIFFERENT transaction (replay of an old approval)', () => {
    const txA = freshTx();
    const txB = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 4_000_000n });
    const witnessForB = deviceWitness(txB, Role.External, 0);
    expect(() => applyHwWitnesses(txA, [witnessForB], txA.body.hash.toString(), keys, expected)).toThrow(
      /failed verification/,
    );
  });

  // ---- Trezor-style witnesses: identified by public key instead of BIP32 path (T6.4) ----

  /** Simulate a Trezor witness: pubKey + signature over the body hash, no path. */
  function trezorWitness(tx: Tx, role: number, index: number): HwWitness {
    const bodyHash = fromHex(tx.body.hash.toString());
    const { pubKey, signature } = deriveKey(root, 0, role, index).sign(bodyHash);
    return { pubKeyHex: toHex(pubKey), witnessSignatureHex: toHex(signature) };
  }

  it('accepts a pubkey-identified (Trezor) witness', () => {
    const tx = freshTx();
    applyHwWitnesses(tx, [trezorWitness(tx, Role.External, 0)], tx.body.hash.toString(), keys, expected);
    expect(tx.witnesses.vkeyWitnesses?.length).toBe(1);
  });

  it('rejects a pubkey witness from a key the account does not expect', () => {
    const tx = freshTx();
    const foreign = trezorWitness(tx, Role.External, 5); // valid sig, but not an expected signer key
    expect(() => applyHwWitnesses(tx, [foreign], tx.body.hash.toString(), keys, expected)).toThrow(
      /missing witness/,
    );
  });

  it('rejects a witness with neither path nor pubkey identifier', () => {
    const tx = freshTx();
    const { witnessSignatureHex } = deviceWitness(tx, Role.External, 0);
    expect(() =>
      applyHwWitnesses(tx, [{ witnessSignatureHex }], tx.body.hash.toString(), keys, expected),
    ).toThrow(/missing witness/);
  });

  it('rejects a pubkey witness whose claimed key matches but whose signature is for another tx', () => {
    const txA = freshTx();
    const txB = buildSend(ctxWith(10_000_000n), { toAddress: RECIPIENT, lovelace: 4_000_000n });
    const replayed = trezorWitness(txB, Role.External, 0);
    expect(() => applyHwWitnesses(txA, [replayed], txA.body.hash.toString(), keys, expected)).toThrow(
      /failed verification/,
    );
  });
});
