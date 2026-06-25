// dApp origin allowlist (EXECUTION_PLAN T4.1, extended in T4.6). The set of origins the user has
// authorized via enable(), plus the CIP-30 extensions negotiated for each (T4.6 — answers
// getExtensions()). Persisted in chrome.storage.local. The background enforces this on EVERY gated
// CIP-30 call — the trusted origin is stamped by the content script (CLAUDE.md §1.6), never taken
// from the page.
import { chromeLocalStore, type KeyValueStore } from '../storage';

export const ALLOWLIST_STORAGE_KEY = 'bob:dappAllowlist';

/** Per-origin authorization record. `extensions` = CIP numbers granted at the last enable() call. */
interface AllowlistEntry {
  extensions: number[];
}

type AllowlistMap = Record<string, AllowlistEntry>;

export class Allowlist {
  constructor(private readonly store: KeyValueStore = chromeLocalStore) {}

  /**
   * Read the stored map, transparently migrating the legacy `string[]` format (origins-only, pre-T4.6)
   * to the `{ origin: { extensions } }` shape. Migration is non-destructive on read; it is persisted
   * the next time add()/remove() writes.
   */
  private async read(): Promise<AllowlistMap> {
    const raw = await this.store.get<unknown>(ALLOWLIST_STORAGE_KEY);
    if (Array.isArray(raw)) {
      const map: AllowlistMap = {};
      for (const o of raw) if (typeof o === 'string') map[o] = { extensions: [] };
      return map;
    }
    return (raw as AllowlistMap | undefined) ?? {};
  }

  /** Authorized origins (back-compat shape for listConnectedDapps). */
  async list(): Promise<string[]> {
    return Object.keys(await this.read());
  }

  async has(origin: string): Promise<boolean> {
    return Object.prototype.hasOwnProperty.call(await this.read(), origin);
  }

  /** CIP numbers granted to this origin (empty if origin unknown or no extensions negotiated). */
  async getExtensions(origin: string): Promise<number[]> {
    return (await this.read())[origin]?.extensions ?? [];
  }

  /** Authorize an origin and record the extensions granted to it (upsert — replaces prior extensions). */
  async add(origin: string, extensions: number[] = []): Promise<void> {
    const map = await this.read();
    map[origin] = { extensions };
    await this.store.set(ALLOWLIST_STORAGE_KEY, map);
  }

  async remove(origin: string): Promise<void> {
    const map = await this.read();
    delete map[origin];
    await this.store.set(ALLOWLIST_STORAGE_KEY, map);
  }
}

export const allowlist = new Allowlist();
