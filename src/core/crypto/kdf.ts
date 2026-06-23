// Key-derivation wrapper (EXECUTION_PLAN T1.2). Decision T1.1: PBKDF2-HMAC-SHA256 via
// SubtleCrypto — keeps the strict CSP `script-src 'self'` (no WASM KDF). See IMPLEMENTATION_PLAN §10/§14.
//
// This module turns a password + persisted params into a non-extractable AES-GCM CryptoKey.
// It NEVER stores the password or the derived key — lifetime/caching is the vault's job (T1.5/T1.6).
import { fromBase64, toArrayBuffer, toBase64, utf8ToBytes } from './encoding';

/** OWASP 2023 floor for PBKDF2-HMAC-SHA256. We default to this; raise per-vault via metadata. */
export const PBKDF2_MIN_ITERATIONS = 600_000;
export const DEFAULT_ITERATIONS = 600_000;
/** Random salt length. 32 bytes per IMPLEMENTATION_PLAN §10. */
export const SALT_BYTES = 32;

export type KdfName = 'PBKDF2';
export type KdfHash = 'SHA-256';

/**
 * Self-describing KDF parameters, persisted alongside the ciphertext in vault metadata so the
 * parameters can be migrated forward (e.g. raise `iterations`) without locking out existing vaults.
 */
export interface KdfParams {
  kdf: KdfName;
  hash: KdfHash;
  iterations: number;
  /** base64-encoded random salt (SALT_BYTES). */
  salt: string;
}

/** Fresh params with a cryptographically-random salt. */
export function newKdfParams(iterations: number = DEFAULT_ITERATIONS): KdfParams {
  if (iterations < PBKDF2_MIN_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be >= ${PBKDF2_MIN_ITERATIONS}`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return { kdf: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) };
}

/**
 * Derive the raw 256-bit key material from a password and persisted params. SECRET: the only place
 * this leaves transient scope is the T1.6 unlock cache (`chrome.storage.session`) — never disk, never
 * logs. Returning bytes (vs a CryptoKey) is what lets the key be cached as a serializable value.
 */
export async function deriveKeyBits(password: string, params: KdfParams): Promise<Uint8Array> {
  if (params.kdf !== 'PBKDF2') throw new Error(`unsupported KDF: ${params.kdf}`);
  if (params.iterations < PBKDF2_MIN_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be >= ${PBKDF2_MIN_ITERATIONS}`);
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(utf8ToBytes(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(fromBase64(params.salt)),
      iterations: params.iterations,
      hash: params.hash,
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Import raw 256-bit key material as a **non-extractable** AES-256-GCM key — usable for
 * encrypt/decrypt, but its bytes can never be read back out of the CryptoKey.
 */
export async function importAesKey(bits: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', toArrayBuffer(bits), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Derive the AES-256-GCM key directly from a password — convenience over
 * `importAesKey(deriveKeyBits(...))`, the single derivation path. Result is non-extractable.
 */
export async function deriveAesKey(password: string, params: KdfParams): Promise<CryptoKey> {
  return importAesKey(await deriveKeyBits(password, params));
}
