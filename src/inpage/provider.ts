// Runs in the page's MAIN world. Exposes the CIP-30 provider on window.cardano.<name>.
// MUST NOT touch chrome.* — it has no access. Talks only via window.postMessage to the content relay.
import {
  TARGET_CONTENT,
  TARGET_INPAGE,
  newId,
  type RpcMethod,
  type RpcResponse,
} from '../shared/messages';
import { SUPPORTED_EXTENSIONS, EXTENSION_REGISTRY, type Extension } from '../shared/extensions';

const WALLET_KEY = 'bob';
const WALLET_NAME = 'bob-the-buildooor';

function request<T>(method: RpcMethod, ...params: unknown[]): Promise<T> {
  const id = newId();
  return new Promise<T>((resolve, reject) => {
    function handler(e: MessageEvent) {
      // Strict filtering: same window, our namespaced target, correlated id.
      if (e.source !== window) return;
      const data = e.data as RpcResponse<T> | undefined;
      if (!data || data.target !== TARGET_INPAGE || data.id !== id) return;
      window.removeEventListener('message', handler);
      if (data.error) reject(data.error); // CIP-30 { code, info }
      else resolve(data.result as T);
    }
    window.addEventListener('message', handler);
    window.postMessage({ target: TARGET_CONTENT, id, method, params }, window.location.origin);
  });
}

type ExtMethod = (...args: unknown[]) => Promise<unknown>;

/**
 * Build the granted extensions' api surface generically from EXTENSION_REGISTRY. For each enabled CIP,
 * every method becomes a thin forwarder to `cip{N}.{name}` and is placed either under the `cipNN`
 * namespace or at the api root, per the registry. This is the single dispatch path — a new extension
 * is a registry entry plus a background handler, with no edit here or in the bridge. The forwarders
 * are intentionally generically typed: this object is consumed by external dApp code, not by us.
 */
function extensionApi(enabledCips: number[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ext of EXTENSION_REGISTRY) {
    if (!enabledCips.includes(ext.cip)) continue;
    for (const m of ext.methods) {
      const wire = `${ext.namespace}.${m.name}` as RpcMethod;
      const fn: ExtMethod = (...args) => request(wire, ...args);
      if (m.placement === 'root') {
        out[m.name] = fn;
      } else {
        const ns = (out[ext.namespace] as Record<string, ExtMethod> | undefined) ?? {};
        ns[m.name] = fn;
        out[ext.namespace] = ns;
      }
    }
  }
  return out;
}

/**
 * The full CIP-30 API, granted after enable(). All returns are hex (address bytes / cbor).
 * `enabledCips` is the set negotiated at enable() time — extension methods/namespaces are attached
 * only when their CIP was granted, and `getExtensions()` reports that same set.
 */
function fullApi(enabledCips: number[]) {
  return {
    getExtensions: () => request<Extension[]>('getExtensions'),
    getNetworkId: () => request<number>('getNetworkId'),
    getUtxos: (amount?: string, paginate?: { page: number; limit: number }) =>
      request<string[] | null>('getUtxos', amount, paginate),
    getCollateral: (params?: { amount?: string }) => request<string[]>('getCollateral', params?.amount),
    getBalance: () => request<string>('getBalance'),
    getUsedAddresses: (paginate?: { page: number; limit: number }) =>
      request<string[]>('getUsedAddresses', paginate),
    getUnusedAddresses: () => request<string[]>('getUnusedAddresses'),
    getChangeAddress: () => request<string>('getChangeAddress'),
    getRewardAddresses: () => request<string[]>('getRewardAddresses'),
    signTx: (tx: string, partialSign = false) => request<string>('signTx', tx, partialSign),
    signData: (addr: string, payload: string) =>
      request<{ signature: string; key: string }>('signData', addr, payload),
    submitTx: (tx: string) => request<string>('submitTx', tx),
    experimental: {},
    ...extensionApi(enabledCips),
  };
}

const cardanoApi = {
  apiVersion: '1',
  name: WALLET_NAME,
  icon: 'data:image/svg+xml;base64,', // TODO(T7.5)
  supportedExtensions: SUPPORTED_EXTENSIONS,
  isEnabled: () => request<boolean>('isEnabled'),
  enable: async (opts?: { extensions?: Extension[] }) => {
    // Negotiate extensions: the background returns exactly the granted set (consent-gated; throws a
    // CIP-30 error if declined). Build the API surface to match what was granted.
    const granted = await request<Extension[]>('enable', opts?.extensions ?? []);
    return fullApi(granted.map((e) => e.cip));
  },
};

declare global {
  interface Window {
    cardano?: Record<string, unknown>;
  }
}

window.cardano = window.cardano || {};
if (!window.cardano[WALLET_KEY]) {
  window.cardano[WALLET_KEY] = cardanoApi;
}
