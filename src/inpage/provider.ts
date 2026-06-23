// Runs in the page's MAIN world. Exposes the CIP-30 provider on window.cardano.<name>.
// MUST NOT touch chrome.* — it has no access. Talks only via window.postMessage to the content relay.
import {
  TARGET_CONTENT,
  TARGET_INPAGE,
  newId,
  type RpcMethod,
  type RpcResponse,
} from '../shared/messages';

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

/** The full CIP-30 API, granted after enable(). All returns are hex (address bytes / cbor). */
function fullApi() {
  return {
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
  };
}

const cardanoApi = {
  apiVersion: '1',
  name: WALLET_NAME,
  icon: 'data:image/svg+xml;base64,', // TODO(T7.5)
  supportedExtensions: [] as Array<{ cip: number }>,
  isEnabled: () => request<boolean>('isEnabled'),
  enable: async () => {
    await request<boolean>('enable'); // consent gate (throws CIP-30 error if declined)
    return fullApi();
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
