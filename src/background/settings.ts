// Wallet settings (T2.3): non-secret config — active network + chain provider. Persisted in
// chrome.storage.local. The Blockfrost API key is NOT here for now: in dev it comes from the Vite
// env (.env, baked at build); production key entry is a later Settings.tsx task. No secrets stored.
import { chromeLocalStore, type KeyValueStore } from './storage';
import type { HistoryBackend, Network, ProviderKind } from './provider/index';

export interface WalletSettings {
  network: Network;
  providerKind: ProviderKind;
  /** Ogmios websocket URL (providerKind='ogmios'), e.g. ws://localhost:1337 for a local node. */
  ogmiosUrl?: string | undefined;
  /**
   * Optional Kupo base URL (providerKind='ogmios'), e.g. http://localhost:1442. When set, address/UTxO
   * reads use Kupo's index (fast discovery) and Ogmios is used only for params/submit/evaluate. Ogmios
   * by itself scans the full UTxO set per address query and is too slow for interactive discovery.
   */
  kupoUrl?: string | undefined;
  /**
   * "Dual mode" (providerKind='ogmios'): borrow tx history, token names/images, ADA-Handle lookup and
   * confirmation polling from a remote indexer while the local Ogmios+Kupo stack stays authoritative
   * for state/submit/eval. Reuses the Blockfrost/Koios credentials below. Undefined = local only.
   */
  historyBackend?: HistoryBackend | undefined;
  /** Per-network Blockfrost project ids. Not wallet key material — but still user-scoped credentials. */
  blockfrostProjectIds?: Partial<Record<Network, string>> | undefined;
  /** Optional Koios bearer token (free tier works without one). */
  koiosApiKey?: string | undefined;
  /** Optional custom/self-hosted Koios base URL (incl. API path). Overrides env + the public default. */
  koiosUrl?: string | undefined;
  /**
   * Fetch & show NFT images (A2). Default ON. When off, the SW never contacts the IPFS/HTTP gateway,
   * so it can't leak the wallet's IP + which NFTs it holds — a privacy opt-out. Token NAMES (provider
   * metadata) are unaffected; only the image fetch is gated.
   */
  nftImages?: boolean | undefined;
}

export const SETTINGS_STORAGE_KEY = 'bob:settings';
export const DEFAULT_SETTINGS: WalletSettings = { network: 'preview', providerKind: 'blockfrost', nftImages: true };

export class Settings {
  constructor(private readonly store: KeyValueStore = chromeLocalStore) {}

  async get(): Promise<WalletSettings> {
    const stored = await this.store.get<Partial<WalletSettings>>(SETTINGS_STORAGE_KEY);
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  async update(patch: Partial<WalletSettings>): Promise<WalletSettings> {
    const next = { ...(await this.get()), ...patch };
    await this.store.set(SETTINGS_STORAGE_KEY, next);
    return next;
  }
}

export const settings = new Settings();
