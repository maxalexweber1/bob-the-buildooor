import { describe, it, expect, beforeEach } from 'vitest';
import { Allowlist } from '../src/background/dapp/allowlist';
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
});
