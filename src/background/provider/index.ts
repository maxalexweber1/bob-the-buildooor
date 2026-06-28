// Provider factory/selector (EXECUTION_PLAN T2.3). Builds the active IChainProvider from config.
// Config source order (settings UI lands in T2.3's Settings.tsx; for now env/dev + explicit calls):
//   - network + provider kind + endpoint/key come from the caller (wallet settings in chrome.storage).
//   - Blockfrost preview key for local dev: import.meta.env.VITE_BLOCKFROST_PROJECT_ID_PREVIEW (.env).
export type { IChainProvider, Network, ChainTip, ScriptEvalResult } from './IChainProvider';
export {
  ProviderError,
  ProviderUnsupportedError,
  ProviderHttpError,
  ProviderTimeoutError,
} from './IChainProvider';
export { BlockfrostProvider } from './blockfrost';
export { OgmiosProvider } from './ogmios';
export { OgmiosKupoProvider } from './ogmios-kupo';
export { CompositeProvider } from './composite';
export { KoiosProvider } from './koios';

import type { UTxO } from '@harmoniclabs/buildooor';
import type { IChainProvider, Network } from './IChainProvider';
import { BlockfrostProvider } from './blockfrost';
import { OgmiosProvider } from './ogmios';
import { OgmiosKupoProvider } from './ogmios-kupo';
import { CompositeProvider } from './composite';
import { KoiosProvider } from './koios';

/**
 * Fetch every UTxO across `addresses`. Uses the provider's batched `getUtxosForAddresses` (one
 * round-trip — and on Ogmios one ledger-set scan) when available, else falls back to parallel
 * per-address `getUtxos`. Keeps the wallet handlers provider-agnostic.
 */
export function collectUtxos(provider: IChainProvider, addresses: string[]): Promise<UTxO[]> {
  if (provider.getUtxosForAddresses) return provider.getUtxosForAddresses(addresses);
  return Promise.all(addresses.map((a) => provider.getUtxos(a))).then((rows) => rows.flat());
}

export type ProviderKind = 'blockfrost' | 'koios' | 'ogmios';

/** Remote indexer that can back the "history/metadata" half of a composite (a local Ogmios+Kupo
 *  primary can't serve tx history, token names/images, ADA-Handle lookup or confirmation polling). */
export type HistoryBackend = 'blockfrost' | 'koios';

export interface ProviderConfig {
  kind: ProviderKind;
  network: Network;
  /** Blockfrost project id (kind='blockfrost'). */
  blockfrostProjectId?: string | undefined;
  /** Optional Koios bearer token (kind='koios'). */
  koiosApiKey?: string | undefined;
  /** Optional custom/self-hosted Koios base URL (kind='koios'); falls back to env, then the public default. */
  koiosUrl?: string | undefined;
  /** Ogmios websocket URL, e.g. ws://localhost:1337 (kind='ogmios'). */
  ogmiosUrl?: string | undefined;
  /**
   * Optional Kupo base URL, e.g. http://localhost:1442 (kind='ogmios'). When set, address/UTxO reads
   * go to Kupo (indexed → fast discovery) and Ogmios is used only for params/submit/evaluate. Ogmios
   * alone can't do interactive address discovery (full-set scan per query).
   */
  kupoUrl?: string | undefined;
  /**
   * Optional "dual mode" (kind='ogmios'): a remote indexer that supplies tx history, token
   * names/images, ADA-Handle lookup and confirmation polling — the indexed extras the local
   * Ogmios(+Kupo) stack can't. Reuses the Blockfrost/Koios credentials below. Skipped silently if its
   * credential is missing, so the local provider still works.
   */
  historyBackend?: HistoryBackend | undefined;
  timeoutMs?: number | undefined;
}

export function createProvider(config: ProviderConfig): IChainProvider {
  switch (config.kind) {
    case 'blockfrost': {
      const projectId = config.blockfrostProjectId ?? blockfrostKeyFromEnv(config.network);
      if (!projectId) throw new Error(`no Blockfrost project id configured for ${config.network}`);
      return new BlockfrostProvider(config.network, projectId, { timeoutMs: config.timeoutMs });
    }
    case 'koios':
      return new KoiosProvider(config.network, {
        apiKey: config.koiosApiKey,
        // explicit setting wins; else env; else the public default (the KoiosProvider handles '').
        baseUrl: config.koiosUrl || koiosUrlFromEnv(config.network),
        timeoutMs: config.timeoutMs,
      });
    case 'ogmios': {
      if (!config.ogmiosUrl) throw new Error('ogmios provider requires an ogmiosUrl');
      const kupoUrl = config.kupoUrl || kupoUrlFromEnv(config.network);
      const remote = config.historyBackend ? buildHistoryBackend(config.historyBackend, config) : undefined;

      if (kupoUrl) {
        // Local-first: Kupo serves indexed reads, Ogmios serves state/submit/eval. A remote indexer,
        // if set, only adds the extras Kupo+Ogmios can't (history/token-metadata/handle lookup).
        const local = new OgmiosKupoProvider(config.network, config.ogmiosUrl, kupoUrl, { timeoutMs: config.timeoutMs });
        return remote ? new CompositeProvider(local, remote) : local;
      }

      const ogmios = new OgmiosProvider(config.network, config.ogmiosUrl, { timeoutMs: config.timeoutMs });
      // No Kupo: a plain-Ogmios address scan is ~O(whole UTxO set) and times out under discovery. If a
      // remote indexer is configured, route READS (and history) to it and keep Ogmios for submit +
      // Plutus evaluate. Otherwise fall back to plain Ogmios (correct but slow — last resort).
      if (remote) return new CompositeProvider(ogmios, remote, { reads: remote });
      return ogmios;
    }
  }
}

/**
 * Build the secondary (history/metadata) provider for a composite. Tolerant: returns undefined if the
 * chosen backend's credential is missing, so the local provider still works (just without the extras).
 */
function buildHistoryBackend(kind: HistoryBackend, config: ProviderConfig): IChainProvider | undefined {
  if (kind === 'blockfrost') {
    const projectId = config.blockfrostProjectId ?? blockfrostKeyFromEnv(config.network);
    if (!projectId) return undefined;
    return new BlockfrostProvider(config.network, projectId, { timeoutMs: config.timeoutMs });
  }
  // koios: works keyless (the public endpoint), so always constructible
  return new KoiosProvider(config.network, {
    apiKey: config.koiosApiKey,
    baseUrl: config.koiosUrl || koiosUrlFromEnv(config.network),
    timeoutMs: config.timeoutMs,
  });
}

/** Local-dev fallback: read the Blockfrost key from Vite env (.env, gitignored). */
function blockfrostKeyFromEnv(network: Network): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  switch (network) {
    case 'preview':
      return env.VITE_BLOCKFROST_PROJECT_ID_PREVIEW;
    case 'preprod':
      return env.VITE_BLOCKFROST_PROJECT_ID_PREPROD;
    case 'mainnet':
      return env.VITE_BLOCKFROST_PROJECT_ID_MAINNET;
  }
}

/**
 * Self-hosted / custom Koios endpoint from Vite env (.env, gitignored): a per-network
 * VITE_KOIOS_URL_<NET> wins, else the generic VITE_KOIOS_URL. Undefined → public Koios default.
 */
function koiosUrlFromEnv(network: Network): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  const perNetwork =
    network === 'preview'
      ? env.VITE_KOIOS_URL_PREVIEW
      : network === 'preprod'
        ? env.VITE_KOIOS_URL_PREPROD
        : env.VITE_KOIOS_URL_MAINNET;
  // `||` (not `??`): an empty string from an unset-but-present `.env` line must NOT win — fall back.
  return perNetwork || env.VITE_KOIOS_URL || undefined;
}

/** Local-dev Kupo endpoint from Vite env (.env): a per-network VITE_KUPO_URL_<NET> wins, else the
 *  generic VITE_KUPO_URL. Undefined → no Kupo (plain Ogmios). */
function kupoUrlFromEnv(network: Network): string | undefined {
  const env = import.meta.env as Record<string, string | undefined>;
  const perNetwork =
    network === 'preview'
      ? env.VITE_KUPO_URL_PREVIEW
      : network === 'preprod'
        ? env.VITE_KUPO_URL_PREPROD
        : env.VITE_KUPO_URL_MAINNET;
  return perNetwork || env.VITE_KUPO_URL || undefined;
}
