import { describe, it, expect } from 'vitest';
import { newKdfParams, deriveAesKey, PBKDF2_MIN_ITERATIONS, SALT_BYTES } from '../src/core/crypto/kdf';
import { aesGcmEncrypt, aesGcmDecrypt, IV_BYTES, type AeadBlob } from '../src/core/crypto/aead';
import { utf8ToBytes, bytesToUtf8, fromBase64, toBase64 } from '../src/core/crypto/encoding';

const PASSWORD = 'correct horse battery staple';
const SECRET = 'all the secret seed phrase words go here, encrypted at rest';

describe('encoding', () => {
  it('base64 round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 127, 128]);
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
  });

  it('utf8 round-trips (incl. multibyte)', () => {
    const s = 'bob — ₳ — 🐢';
    expect(bytesToUtf8(utf8ToBytes(s))).toBe(s);
  });
});

describe('KDF params (PBKDF2 / T1.1 decision)', () => {
  it('produces self-describing PBKDF2 params with a 32-byte random salt', () => {
    const p = newKdfParams();
    expect(p.kdf).toBe('PBKDF2');
    expect(p.hash).toBe('SHA-256');
    expect(p.iterations).toBeGreaterThanOrEqual(PBKDF2_MIN_ITERATIONS);
    expect(fromBase64(p.salt).length).toBe(SALT_BYTES);
  });

  it('generates a fresh random salt each call', () => {
    expect(newKdfParams().salt).not.toBe(newKdfParams().salt);
  });

  it('rejects an iteration count below the OWASP floor', () => {
    expect(() => newKdfParams(100)).toThrow();
    const weak = { kdf: 'PBKDF2' as const, hash: 'SHA-256' as const, iterations: 100, salt: toBase64(new Uint8Array(SALT_BYTES)) };
    return expect(deriveAesKey(PASSWORD, weak)).rejects.toThrow();
  });
});

describe('AES-256-GCM AEAD (T1.2 done-when)', () => {
  it('round-trips: encrypt → decrypt returns the plaintext', async () => {
    const params = newKdfParams();
    const key = await deriveAesKey(PASSWORD, params);

    const blob = await aesGcmEncrypt(key, utf8ToBytes(SECRET));
    // Simulate persistence: params+blob serialize to JSON in the vault.
    const onDisk = JSON.parse(JSON.stringify({ params, blob })) as { params: typeof params; blob: AeadBlob };

    const reKey = await deriveAesKey(PASSWORD, onDisk.params);
    expect(bytesToUtf8(await aesGcmDecrypt(reKey, onDisk.blob))).toBe(SECRET);
  });

  it('uses a fresh 12-byte IV per encryption', async () => {
    const key = await deriveAesKey(PASSWORD, newKdfParams());
    const a = await aesGcmEncrypt(key, utf8ToBytes(SECRET));
    const b = await aesGcmEncrypt(key, utf8ToBytes(SECRET));
    expect(fromBase64(a.iv).length).toBe(IV_BYTES);
    expect(a.iv).not.toBe(b.iv); // distinct IV → distinct ciphertext for identical plaintext
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects the WRONG password (same salt, different key)', async () => {
    const params = newKdfParams();
    const blob = await aesGcmEncrypt(await deriveAesKey(PASSWORD, params), utf8ToBytes(SECRET));
    const wrongKey = await deriveAesKey('not the password', params);
    await expect(aesGcmDecrypt(wrongKey, blob)).rejects.toThrow();
  });

  it('rejects TAMPERED ciphertext (GCM auth tag fails)', async () => {
    const params = newKdfParams();
    const key = await deriveAesKey(PASSWORD, params);
    const blob = await aesGcmEncrypt(key, utf8ToBytes(SECRET));

    const bytes = fromBase64(blob.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01; // flip one bit
    const tampered: AeadBlob = { iv: blob.iv, ciphertext: toBase64(bytes) };
    await expect(aesGcmDecrypt(key, tampered)).rejects.toThrow();
  });

  it('rejects a tampered IV', async () => {
    const params = newKdfParams();
    const key = await deriveAesKey(PASSWORD, params);
    const blob = await aesGcmEncrypt(key, utf8ToBytes(SECRET));

    const iv = fromBase64(blob.iv);
    iv[0] = (iv[0] ?? 0) ^ 0x01;
    await expect(aesGcmDecrypt(key, { iv: toBase64(iv), ciphertext: blob.ciphertext })).rejects.toThrow();
  });
});
