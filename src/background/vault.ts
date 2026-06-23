// The vault (EXECUTION_PLAN T1.5): the seed phrase encrypted at rest in chrome.storage.local.
// Composes the T1.2 crypto (PBKDF2 → AES-256-GCM) with the BIP39 layer. Lives in the privileged
// background context.
//
// SECURITY (CLAUDE.md §1):
//  - Only CIPHERTEXT is persisted. The mnemonic is decrypted into a transient return value on unlock
//    and is the caller's responsibility to keep in function scope (→ derive root → discard).
//  - The decryption key is NEVER persisted here in plaintext. Caching the derived key across SW death
//    (chrome.storage.session) is layered on in T1.6 — this module stays password-driven.
//  - Error messages are secret-free (no password, no plaintext).
import {
  type KdfParams,
  deriveKeyBits,
  importAesKey,
  newKdfParams,
} from '../core/crypto/kdf';
import { type AeadBlob, aesGcmEncrypt, aesGcmDecrypt } from '../core/crypto/aead';
import { utf8ToBytes, bytesToUtf8, toBase64, fromBase64 } from '../core/crypto/encoding';
import { isValidMnemonic } from '../core/mnemonic';
import { chromeLocalStore, chromeSessionStore, type KeyValueStore } from './storage';

export const VAULT_STORAGE_KEY = 'bob:vault';
/** Session-only cache of the derived key (base64). Cleared on lock / browser close (T1.6). */
export const SESSION_KEY_CACHE = 'bob:vaultKey';
const VAULT_VERSION = 1 as const;

/** On-disk vault shape. All fields are non-secret EXCEPT what's inside `blob.ciphertext` (encrypted). */
export interface VaultRecord {
  version: typeof VAULT_VERSION;
  kdf: KdfParams;
  blob: AeadBlob;
}

export class VaultNotInitializedError extends Error {
  constructor() {
    super('vault not initialized');
    this.name = 'VaultNotInitializedError';
  }
}
export class VaultAlreadyExistsError extends Error {
  constructor() {
    super('vault already exists');
    this.name = 'VaultAlreadyExistsError';
  }
}
export class WrongPasswordError extends Error {
  constructor() {
    super('wrong password'); // deliberately generic — never echoes the password or plaintext
    this.name = 'WrongPasswordError';
  }
}
export class VaultLockedError extends Error {
  constructor() {
    super('vault is locked');
    this.name = 'VaultLockedError';
  }
}

export class Vault {
  constructor(
    private readonly store: KeyValueStore = chromeLocalStore,
    /** In-memory, SW-respawn-surviving store for the derived key (NEVER the password/seed). */
    private readonly session: KeyValueStore = chromeSessionStore,
  ) {}

  async isInitialized(): Promise<boolean> {
    return (await this.store.get<VaultRecord>(VAULT_STORAGE_KEY)) !== undefined;
  }

  /** True iff the derived key is cached in session — i.e. unlocked and surviving SW death (T1.6). */
  async isUnlocked(): Promise<boolean> {
    return (await this.session.get<string>(SESSION_KEY_CACHE)) !== undefined;
  }

  /**
   * Encrypt `mnemonic` under `password` and persist. Leaves the vault unlocked (caches the key).
   * Throws if a vault already exists.
   */
  async create(mnemonic: string, password: string): Promise<void> {
    if (!isValidMnemonic(mnemonic)) throw new Error('invalid mnemonic');
    if (await this.isInitialized()) throw new VaultAlreadyExistsError();

    const kdf = newKdfParams();
    const bits = await deriveKeyBits(password, kdf);
    const blob = await aesGcmEncrypt(await importAesKey(bits), utf8ToBytes(mnemonic));
    const record: VaultRecord = { version: VAULT_VERSION, kdf, blob };
    await this.store.set(VAULT_STORAGE_KEY, record);
    await this.cacheKey(bits);
  }

  /**
   * Decrypt with `password`, cache the derived key for SW-death survival, and return the mnemonic.
   * Throws WrongPasswordError on a bad password (GCM tag fails) without leaking which part was wrong.
   * Caller must treat the result as a transient secret.
   */
  async unlock(password: string): Promise<string> {
    const record = await this.store.get<VaultRecord>(VAULT_STORAGE_KEY);
    if (!record) throw new VaultNotInitializedError();

    const bits = await deriveKeyBits(password, record.kdf);
    const plaintext = await this.decryptOrThrow(bits, record.blob);
    await this.cacheKey(bits);
    return bytesToUtf8(plaintext);
  }

  /**
   * Decrypt the mnemonic using the cached session key — the SW-death path: no password needed after
   * a respawn. Throws VaultLockedError if locked (no cached key) and self-locks if the cache is stale.
   */
  async getMnemonic(): Promise<string> {
    const cached = await this.session.get<string>(SESSION_KEY_CACHE);
    if (!cached) throw new VaultLockedError();
    const record = await this.store.get<VaultRecord>(VAULT_STORAGE_KEY);
    if (!record) throw new VaultNotInitializedError();

    let plaintext: Uint8Array;
    try {
      plaintext = await aesGcmDecrypt(await importAesKey(fromBase64(cached)), record.blob);
    } catch {
      // Cached key no longer matches the vault (e.g. password changed elsewhere) → drop it.
      await this.lock();
      throw new VaultLockedError();
    }
    return bytesToUtf8(plaintext);
  }

  /** Lock: drop the cached key from session. The encrypted vault on disk is untouched. */
  async lock(): Promise<void> {
    await this.session.remove(SESSION_KEY_CACHE);
  }

  /** Wipe the vault AND lock (e.g. reset wallet). Irreversible without the mnemonic backup. */
  async clear(): Promise<void> {
    await this.store.remove(VAULT_STORAGE_KEY);
    await this.lock();
  }

  private async cacheKey(bits: Uint8Array): Promise<void> {
    await this.session.set(SESSION_KEY_CACHE, toBase64(bits));
  }

  private async decryptOrThrow(bits: Uint8Array, blob: AeadBlob): Promise<Uint8Array> {
    try {
      return await aesGcmDecrypt(await importAesKey(bits), blob);
    } catch {
      throw new WrongPasswordError();
    }
  }
}

/** Default instance backed by chrome.storage.local/session — used by the SW. Tests construct their own. */
export const vault = new Vault();
