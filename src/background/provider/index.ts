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
export { KoiosProvider } from './koios';

import type { IChainProvider, Network } from './IChainProvider';
import { BlockfrostProvider } from './blockfrost';
import { OgmiosProvider } from './ogmios';
import { KoiosProvider } from './koios';

export type ProviderKind = 'blockfrost' | 'koios' | 'ogmios';

export interface ProviderConfig {
  kind: ProviderKind;
  network: Network;
  /** Blockfrost project id (kind='blockfrost'). */
  blockfrostProjectId?: string | undefined;
  /** Optional Koios bearer token (kind='koios'). */
  koiosApiKey?: string | undefined;
  /** Ogmios websocket URL, e.g. ws://localhost:1337 (kind='ogmios'). */
  ogmiosUrl?: string | undefined;
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
        timeoutMs: config.timeoutMs,
      });
    case 'ogmios': {
      if (!config.ogmiosUrl) throw new Error('ogmios provider requires an ogmiosUrl');
      return new OgmiosProvider(config.network, config.ogmiosUrl, { timeoutMs: config.timeoutMs });
    }
  }
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
