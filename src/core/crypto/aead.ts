// Authenticated encryption wrapper (EXECUTION_PLAN T1.2): AES-256-GCM via SubtleCrypto.
// A fresh random IV is generated per encryption — never reuse an (key, IV) pair under GCM.
// The 16-byte GCM auth tag is appended to the ciphertext by WebCrypto, so any tamper (incl. a
// flipped bit or wrong key) makes decrypt reject. No secrets are retained by this module.
import { fromBase64, toArrayBuffer, toBase64 } from './encoding';

/** GCM nonce length. 12 bytes is the standard/recommended IV size (IMPLEMENTATION_PLAN §10). */
export const IV_BYTES = 12;

export interface AeadBlob {
  /** base64-encoded random IV (IV_BYTES). */
  iv: string;
  /** base64-encoded AES-GCM output (ciphertext || 16-byte auth tag). */
  ciphertext: string;
}

export async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<AeadBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ct)) };
}

/** Throws (rejects) if the key is wrong or the blob was tampered with — the GCM tag won't verify. */
export async function aesGcmDecrypt(key: CryptoKey, blob: AeadBlob): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromBase64(blob.iv)) },
    key,
    toArrayBuffer(fromBase64(blob.ciphertext)),
  );
  return new Uint8Array(pt);
}
