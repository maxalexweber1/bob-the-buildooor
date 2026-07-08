// Provider-shared network helpers (T2.2/T2.3). Pure, fetch-based (no SDK deps — keeps the SW lean
// and CSP-safe). All requests carry a timeout: the MV3 SW is killed on a fetch > 30 s, so we default
// well under that (IMPLEMENTATION_PLAN §5, CLAUDE.md §6).
import {
  defaultMainnetGenesisInfos,
  defaultPreprodGenesisInfos,
  defaultPreviewGenesisInfos,
  type GenesisInfos,
} from '@harmoniclabs/buildooor';
import type { Network } from './IChainProvider';
import { ProviderHttpError, ProviderTimeoutError } from './IChainProvider';

export const DEFAULT_TIMEOUT_MS = 20_000;

export const BLOCKFROST_BASE_URL: Record<Network, string> = {
  mainnet: 'https://cardano-mainnet.blockfrost.io/api/v0',
  preview: 'https://cardano-preview.blockfrost.io/api/v0',
  preprod: 'https://cardano-preprod.blockfrost.io/api/v0',
};

export const KOIOS_BASE_URL: Record<Network, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
};

/** Slot↔POSIX geometry the tx builder uses for validity windows. buildooor ships the constants. */
export function genesisInfosFor(network: Network): GenesisInfos {
  switch (network) {
    case 'mainnet':
      return defaultMainnetGenesisInfos;
    case 'preprod':
      return defaultPreprodGenesisInfos;
    case 'preview':
      return defaultPreviewGenesisInfos;
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: BodyInit;
  /** Treat HTTP 404 as "no data" and return null instead of throwing (e.g. an unused address). */
  allow404?: boolean;
}

/**
 * Strip credentials, query and hash from a URL before it can appear in an error message: a custom
 * provider URL may carry `user:password@` or `?token=…` secrets, and provider errors can travel to
 * untrusted surfaces (a dApp sees submitTx failures).
 */
export function sanitizeUrlForError(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/**
 * fetch + JSON with an AbortController timeout. Returns null on 404 when `allow404` is set
 * (Blockfrost returns 404 for an address/tx it has never seen — a normal "empty" case, not an error).
 * Error messages carry only the SANITIZED URL + status + a bounded body excerpt — enough for local
 * troubleshooting, no credentials. dApp-facing paths must still map these to generic strings.
 */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, method = 'GET', body, allow404 = false } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method, headers: headers ?? {}, body: body ?? null, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ProviderTimeoutError(`request to ${sanitizeUrlForError(url)} timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 404 && allow404) return null;
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ProviderHttpError(res.status, `HTTP ${res.status} for ${sanitizeUrlForError(url)}: ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
