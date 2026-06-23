// CIP-8 COSE_Sign1 production (EXECUTION_PLAN T4.5). HarmonicLabs gives us the CBOR + Ed25519
// primitives but not COSE itself — we assemble the structures by hand (mirror of ODATANO's
// cose-verifier.ts, reversed). Pure & framework-free.
//
//   Sig_structure = [ "Signature1", protected_bstr, external_aad(h''), payload ]
//   COSE_Sign1    = [ protected_bstr, { hashed:false }, payload, signature ]
//   COSE_Key      = { 1:OKP(1), 3:EdDSA(-8), -1:Ed25519(6), -2: pubkey }
import {
  Cbor,
  CborArray,
  CborBytes,
  CborMap,
  CborNegInt,
  CborSimple,
  CborText,
  CborUInt,
  signExtendedEd25519_sync,
} from '@harmoniclabs/buildooor';
import { toHex } from '../crypto/encoding';

const ALG_EdDSA = -8;

/** CIP-30 signData result: hex-encoded COSE_Sign1 (`signature`) + COSE_Key (`key`). */
export interface CoseSignature {
  signature: string;
  key: string;
}

export function buildCoseSign1(
  payload: Uint8Array,
  addressBytes: Uint8Array,
  extendedPrivKey: Uint8Array, // XPrv.toPrivateKeyBytes()
  pubKey: Uint8Array, // 32-byte Ed25519 public key
): CoseSignature {
  // Protected header carries alg + the signing address (CIP-8). Its EXACT bytes are reused in the
  // Sig_structure, so we encode once and never re-encode.
  const protectedBytes = Cbor.encode(
    new CborMap([
      { k: new CborUInt(1), v: new CborNegInt(ALG_EdDSA) },
      { k: new CborText('address'), v: new CborBytes(addressBytes) },
    ]),
  );

  const sigStructure = Cbor.encode(
    new CborArray([
      new CborText('Signature1'),
      new CborBytes(protectedBytes),
      new CborBytes(new Uint8Array(0)), // empty external_aad
      new CborBytes(payload),
    ]),
  );
  const { signature } = signExtendedEd25519_sync(sigStructure, extendedPrivKey);

  const coseSign1 = Cbor.encode(
    new CborArray([
      new CborBytes(protectedBytes),
      new CborMap([{ k: new CborText('hashed'), v: new CborSimple(false) }]),
      new CborBytes(payload),
      new CborBytes(signature),
    ]),
  );
  const coseKey = Cbor.encode(
    new CborMap([
      { k: new CborUInt(1), v: new CborUInt(1) }, // kty: OKP
      { k: new CborUInt(3), v: new CborNegInt(ALG_EdDSA) }, // alg: EdDSA
      { k: new CborNegInt(-1), v: new CborUInt(6) }, // crv: Ed25519
      { k: new CborNegInt(-2), v: new CborBytes(pubKey) }, // x: public key
    ]),
  );

  return { signature: toHex(coseSign1), key: toHex(coseKey) };
}
