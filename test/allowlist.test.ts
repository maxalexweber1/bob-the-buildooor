import { describe, it, expect, beforeEach } from 'vitest';
import { Allowlist, ALLOWLIST_STORAGE_KEY } from '../src/background/dapp/allowlist';
import type { KeyValueStore } from '../src/background/storage';

class MemoryStore implements KeyValueStore {
  private m = new Map<string, string>();
  async get<T>(k: string): Promise<T | undefined> {
    const r = this.m.get(k);
    return r === undefined ? undefined : (JSON.parse(r) as T);
  }
  async set<T>(k: string, v: T): Promise<void> {
    this.m.set(k, JSON.stringify(v));
  }
  async remove(k: string): Promise<void> {
    this.m.delete(k);
  }
}

const X = 'https://dapp.example';
const Y = 'https://other.example';

describe('Allowlist (T4.1)', () => {
  let a: Allowlist;
  beforeEach(() => {
    a = new Allowlist(new MemoryStore());
  });

  it('starts empty', async () => {
    expect(await a.list()).toEqual([]);
    expect(await a.has(X)).toBe(false);
  });

  it('adds (deduped) and reports membership', async () => {
    await a.add(X);
    await a.add(X);
    expect(await a.list()).toEqual([X]);
    expect(await a.has(X)).toBe(true);
    expect(await a.has(Y)).toBe(false);
  });

  it('removes an origin', async () => {
    await a.add(X);
    await a.add(Y);
    await a.remove(X);
    expect(await a.list()).toEqual([Y]);
    expect(await a.has(X)).toBe(false);
  });

  it('records and returns per-origin extensions (T4.6)', async () => {
    await a.add(X, [95]);
    await a.add(Y); // defaults to none
    expect(await a.getExtensions(X)).toEqual([95]);
    expect(await a.getExtensions(Y)).toEqual([]);
    expect(await a.getExtensions('https://unknown.example')).toEqual([]);
  });

  it('re-adding replaces the granted extensions (T4.6)', async () => {
    await a.add(X, [95]);
    await a.add(X, []); // dApp re-enables without governance
    expect(await a.getExtensions(X)).toEqual([]);
    expect(await a.has(X)).toBe(true);
  });

  it('migrates the legacy string[] format transparently (T4.6)', async () => {
    const store = new MemoryStore();
    await store.set(ALLOWLIST_STORAGE_KEY, [X, Y]); // pre-T4.6 origins-only shape
    const migrated = new Allowlist(store);
    expect(await migrated.list()).toEqual([X, Y]);
    expect(await migrated.has(X)).toBe(true);
    expect(await migrated.getExtensions(X)).toEqual([]);
    // a write persists the migrated map shape
    await migrated.add(X, [95]);
    expect(await migrated.getExtensions(X)).toEqual([95]);
  });
});
