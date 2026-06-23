import { describe, it, expect } from 'vitest';
import { Address } from '@harmoniclabs/buildooor';
import { mnemonicToRoot, deriveKey, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { buildCoseSign1 } from '../src/core/cose/sign';
import { verifyCoseSign1 } from '../src/core/cose/verify';
import { utf8ToBytes } from '../src/core/crypto/encoding';

const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
const key = deriveKey(root, 0, Role.External, 0);
const addrBytes = Address.fromString(baseAddress(root, 'testnet', 0, 0)).toBuffer();

describe('CIP-8 COSE_Sign1 (T4.5)', () => {
  it('round-trips: sign → verify, payload recovered', () => {
    const { signature, key: coseKey } = buildCoseSign1(
      utf8ToBytes('hello cardano'),
      addrBytes,
      key.toPrivateKeyBytes(),
      key.public().toPubKeyBytes(),
    );
    const r = verifyCoseSign1(signature, coseKey);
    expect(r.valid).toBe(true);
    expect(r.payloadUtf8).toBe('hello cardano');
  });

  it('fails verification under a different key', () => {
    const mine = buildCoseSign1(utf8ToBytes('msg'), addrBytes, key.toPrivateKeyBytes(), key.public().toPubKeyBytes());
    const other = deriveKey(root, 0, Role.External, 1);
    const otherCose = buildCoseSign1(utf8ToBytes('msg'), addrBytes, other.toPrivateKeyBytes(), other.public().toPubKeyBytes());
    // Signature from `mine`, public key from `other` → must not verify.
    expect(verifyCoseSign1(mine.signature, otherCose.key).valid).toBe(false);
  });
});
