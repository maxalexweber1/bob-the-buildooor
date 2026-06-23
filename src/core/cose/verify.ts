// CIP-8 COSE_Sign1 verification (adapted from ODATANO's cose-verifier.ts). Used for tests and a future
// "Sign-in with Cardano" verify path. Re-builds the Sig_structure from the EXACT received protected
// bytes and checks the Ed25519 signature against the COSE_Key public key.
import {
  Cbor,
  CborArray,
  CborBytes,
  CborMap,
  CborNegInt,
  CborText,
  CborUInt,
  verifyEd25519Signature_sync,
} from '@harmoniclabs/buildooor';
import { bytesToUtf8, fromHex } from '../crypto/encoding';

export interface CoseVerifyResult {
  valid: boolean;
  payloadUtf8: string;
}

export function verifyCoseSign1(coseSignHex: string, coseKeyHex: string): CoseVerifyResult {
  const obj = Cbor.parse(fromHex(coseSignHex));
  if (!(obj instanceof CborArray) || obj.array.length !== 4) {
    return { valid: false, payloadUtf8: '' };
  }
  const [prot, , payload, signature] = obj.array;
  if (!(prot instanceof CborBytes) || !(payload instanceof CborBytes) || !(signature instanceof CborBytes)) {
    return { valid: false, payloadUtf8: '' };
  }

  const payloadUtf8 = bytesToUtf8(payload.bytes);
  const pubKey = parseCoseKeyX(coseKeyHex);
  if (!pubKey) return { valid: false, payloadUtf8 };

  const sigStructure = Cbor.encode(
    new CborArray([
      new CborText('Signature1'),
      new CborBytes(prot.bytes),
      new CborBytes(new Uint8Array(0)),
      new CborBytes(payload.bytes),
    ]),
  );
  return { valid: verifyEd25519Signature_sync(signature.bytes, sigStructure, pubKey), payloadUtf8 };
}

/** Extract the raw Ed25519 public key (COSE_Key label -2). */
function parseCoseKeyX(coseKeyHex: string): Uint8Array | null {
  const obj = Cbor.parse(fromHex(coseKeyHex));
  if (!(obj instanceof CborMap)) return null;
  for (const e of obj.map) {
    const isLabelMinus2 =
      (e.k instanceof CborNegInt || e.k instanceof CborUInt) && Number(e.k.num) === -2;
    if (isLabelMinus2 && e.v instanceof CborBytes) return e.v.bytes;
  }
  return null;
}
