// dApp origin allowlist (EXECUTION_PLAN T4.1). The set of origins the user has authorized via enable().
// Persisted in chrome.storage.local. The background enforces this on EVERY gated CIP-30 call — the
// trusted origin is stamped by the content script (CLAUDE.md §1.6), never taken from the page.
import { chromeLocalStore, type KeyValueStore } from '../storage';

export const ALLOWLIST_STORAGE_KEY = 'bob:dappAllowlist';

export class Allowlist {
  constructor(private readonly store: KeyValueStore = chromeLocalStore) {}

  async list(): Promise<string[]> {
    return (await this.store.get<string[]>(ALLOWLIST_STORAGE_KEY)) ?? [];
  }
  async has(origin: string): Promise<boolean> {
    return (await this.list()).includes(origin);
  }
  async add(origin: string): Promise<void> {
    const l = await this.list();
    if (!l.includes(origin)) {
      l.push(origin);
      await this.store.set(ALLOWLIST_STORAGE_KEY, l);
    }
  }
  async remove(origin: string): Promise<void> {
    await this.store.set(
      ALLOWLIST_STORAGE_KEY,
      (await this.list()).filter((o) => o !== origin),
    );
  }
}

export const allowlist = new Allowlist();
