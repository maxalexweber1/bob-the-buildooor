// Resolve the active IChainProvider from wallet settings (T2.3). Cached by config signature so we
// don't rebuild (and, for Ogmios, reconnect) on every call. The cache is a module global — it dies
// with the SW, which is fine: it's rebuilt on demand and holds no wallet secrets.
import { settings } from './settings';
import { createProvider, type IChainProvider, type ProviderConfig } from './provider/index';

let cached: { sig: string; provider: IChainProvider } | null = null;

export async function getProvider(): Promise<IChainProvider> {
  const s = await settings.get();
  const config: ProviderConfig = {
    kind: s.providerKind,
    network: s.network,
    ogmiosUrl: s.ogmiosUrl,
    kupoUrl: s.kupoUrl,
    historyBackend: s.historyBackend,
    blockfrostProjectId: s.blockfrostProjectIds?.[s.network],
    koiosApiKey: s.koiosApiKey,
    koiosUrl: s.koiosUrl,
  };
  const sig = JSON.stringify(config);
  if (cached?.sig === sig) return cached.provider;
  // Release the previous provider's long-lived resources (e.g. an Ogmios WebSocket) before replacing
  // it — otherwise every settings/network change leaks an open socket with live handlers (review #5).
  cached?.provider.close?.();
  const provider = createProvider(config);
  cached = { sig, provider };
  return provider;
}

/** Drop the cached provider (e.g. after a settings change), closing any open connection. */
export function clearProviderCache(): void {
  cached?.provider.close?.();
  cached = null;
}
