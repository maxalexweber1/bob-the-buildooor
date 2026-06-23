// Minimal async key/value abstraction over chrome.storage. Injected into stores (e.g. the vault) so
// they stay unit-testable: node tests pass an in-memory fake, the service worker passes a chrome impl.
// This module holds no secrets itself — it only moves opaque values to/from storage.

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * chrome.storage.local — where the encrypted-at-rest vault lives. NEVER window.localStorage
 * (unavailable in the SW, synchronous, trivially readable — CLAUDE.md §1.2 / IMPLEMENTATION_PLAN §10).
 * `chrome` is referenced lazily inside the methods so importing this module in a non-extension
 * environment (tests) doesn't throw.
 */
export const chromeLocalStore: KeyValueStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const out = await chrome.storage.local.get(key);
    return out[key] as T | undefined;
  },
  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};

/**
 * chrome.storage.session — in-memory, survives SW respawn, cleared on browser close. Holds the
 * derived encryption key for unlock-across-SW-death (T1.6), NEVER the password or the seed.
 * Default access level (TRUSTED_CONTEXTS) is kept so page contexts can't read it.
 */
export const chromeSessionStore: KeyValueStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const out = await chrome.storage.session.get(key);
    return out[key] as T | undefined;
  },
  async set<T>(key: string, value: T): Promise<void> {
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await chrome.storage.session.remove(key);
  },
};
