import { describe, it, expect, beforeEach } from 'vitest';
import {
  Vault,
  VAULT_STORAGE_KEY,
  SESSION_KEY_CACHE,
  VaultNotInitializedError,
  VaultAlreadyExistsError,
  WrongPasswordError,
  VaultLockedError,
  type VaultRecord,
} from '../src/background/vault';
import type { KeyValueStore } from '../src/background/storage';
import { fromBase64 } from '../src/core/crypto/encoding';

// In-memory stand-in for chrome.storage.local. Round-trips values through JSON to faithfully
// simulate structured serialization (so a CryptoKey or any non-serializable secret would surface).
class MemoryStore implements KeyValueStore {
  readonly map = new Map<string, string>();
  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.map.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
  /** Everything currently persisted, as one string — for "no plaintext on disk" assertions. */
  dump(): string {
    return JSON.stringify([...this.map.entries()]);
  }
}

const MNEMONIC = 'abandon '.repeat(23) + 'art';
const PASSWORD = 'a-very-strong-password-123';

async function readRecord(store: MemoryStore): Promise<VaultRecord> {
  const r = await store.get<VaultRecord>(VAULT_STORAGE_KEY);
  if (!r) throw new Error('expected a vault record');
  return r;
}

describe('Vault (T1.5)', () => {
  let store: MemoryStore;
  let session: MemoryStore;
  let vault: Vault;
  beforeEach(() => {
    store = new MemoryStore();
    session = new MemoryStore();
    vault = new Vault(store, session);
  });

  it('is uninitialized before create, initialized after', async () => {
    expect(await vault.isInitialized()).toBe(false);
    await vault.create(MNEMONIC, PASSWORD);
    expect(await vault.isInitialized()).toBe(true);
  });

  it('round-trips: unlock with the correct password returns the mnemonic', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    expect(await vault.unlock(PASSWORD)).toBe(MNEMONIC);
  });

  it('persists across a "service-worker restart" (fresh Vault over the same store)', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    const revived = new Vault(store, session); // new module instance, same backing storage
    expect(await revived.isInitialized()).toBe(true);
    expect(await revived.unlock(PASSWORD)).toBe(MNEMONIC);
  });

  it('NEVER writes the plaintext seed (or password) to storage', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    const disk = store.dump();
    expect(disk).not.toContain('abandon'); // any seed word
    expect(disk).not.toContain('art');
    expect(disk).not.toContain(PASSWORD);

    const record = await readRecord(store);
    expect(record.version).toBe(1);
    expect(record.kdf.kdf).toBe('PBKDF2');
    expect(record.kdf.iterations).toBeGreaterThanOrEqual(600_000);
    expect(typeof record.blob.ciphertext).toBe('string');
  });

  it('rejects the wrong password with WrongPasswordError (no info leak)', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    await expect(vault.unlock('wrong-password')).rejects.toBeInstanceOf(WrongPasswordError);
    await expect(vault.unlock('wrong-password')).rejects.toThrow(/wrong password/);
  });

  it('unlock before create throws VaultNotInitializedError', async () => {
    await expect(vault.unlock(PASSWORD)).rejects.toBeInstanceOf(VaultNotInitializedError);
  });

  it('create twice throws VaultAlreadyExistsError (no silent overwrite)', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    await expect(vault.create(MNEMONIC, PASSWORD)).rejects.toBeInstanceOf(VaultAlreadyExistsError);
  });

  it('create rejects an invalid mnemonic', async () => {
    await expect(vault.create('not a real mnemonic', PASSWORD)).rejects.toThrow(/invalid mnemonic/);
  });

  it('clear wipes the vault', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    await vault.clear();
    expect(await vault.isInitialized()).toBe(false);
    await expect(vault.unlock(PASSWORD)).rejects.toBeInstanceOf(VaultNotInitializedError);
  });

  it('a tampered ciphertext is rejected as a wrong password (GCM integrity)', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    const record = await readRecord(store);
    const flipped = 'A' + record.blob.ciphertext.slice(1); // corrupt base64 head
    await store.set(VAULT_STORAGE_KEY, {
      ...record,
      blob: { ...record.blob, ciphertext: flipped },
    });
    await expect(vault.unlock(PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
  });

  // ---- T1.6: lock/unlock & key caching across SW death ----

  it('is locked before unlock, unlocked after create/unlock', async () => {
    expect(await vault.isUnlocked()).toBe(false);
    await vault.create(MNEMONIC, PASSWORD);
    expect(await vault.isUnlocked()).toBe(true);
    await vault.lock();
    expect(await vault.isUnlocked()).toBe(false);
    await vault.unlock(PASSWORD);
    expect(await vault.isUnlocked()).toBe(true);
  });

  it('caches the 32-byte derived KEY in session — never the password or seed', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    const cached = await session.get<string>(SESSION_KEY_CACHE);
    expect(cached).toBeDefined();
    expect(fromBase64(cached ?? '').length).toBe(32); // raw AES-256 key material

    const dump = session.dump();
    expect(dump).not.toContain('abandon'); // no seed word
    expect(dump).not.toContain('art');
    expect(dump).not.toContain(PASSWORD); // no password
  });

  it('SW-DEATH SURVIVAL: a fresh Vault over the same stores reads the seed WITHOUT the password', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    // Simulate SW termination + respawn: brand-new Vault, same local + session backing.
    const respawned = new Vault(store, session);
    expect(await respawned.isUnlocked()).toBe(true);
    expect(await respawned.getMnemonic()).toBe(MNEMONIC); // no password required
  });

  it('getMnemonic throws VaultLockedError when locked', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    await vault.lock();
    await expect(vault.getMnemonic()).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('a WRONG password does not unlock or cache a key', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    await vault.lock();
    await expect(vault.unlock('nope')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await vault.isUnlocked()).toBe(false);
  });

  it('getMnemonic self-locks if the cached key no longer matches the vault', async () => {
    await vault.create(MNEMONIC, PASSWORD); // store: record A, session: key A
    // Overwrite the on-disk vault with one under a DIFFERENT password, leaving session's key A stale.
    await store.remove(VAULT_STORAGE_KEY);
    const rewriter = new Vault(store, new MemoryStore()); // same local store, throwaway session
    await rewriter.create(MNEMONIC, 'a-totally-different-password'); // store: record B
    // `vault` still has cached key A but `store` now holds record B → decrypt fails → self-lock.
    await expect(vault.getMnemonic()).rejects.toBeInstanceOf(VaultLockedError);
    expect(await vault.isUnlocked()).toBe(false);
  });

  it('clear() also locks (drops the cached key)', async () => {
    await vault.create(MNEMONIC, PASSWORD);
    await vault.clear();
    expect(await vault.isUnlocked()).toBe(false);
  });
});
