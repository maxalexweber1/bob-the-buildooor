// Single source of truth for the cross-context message protocol (EXECUTION_PLAN T0.3).
// inpage (MAIN) ⇄ content (ISOLATED) ⇄ background (SW) ⇄ popup.

export const TARGET_CONTENT = 'bob:content' as const;
export const TARGET_INPAGE = 'bob:inpage' as const;
/** Long-lived port name for the dApp CIP-30 bridge — keeps the SW alive during user approval. */
export const DAPP_PORT = 'bob:cip30' as const;

/** CIP-30 + internal methods. Extend as handlers land. */
export type RpcMethod =
  | 'enable'
  | 'isEnabled'
  | 'getNetworkId'
  | 'getUtxos'
  | 'getBalance'
  | 'getUsedAddresses'
  | 'getUnusedAddresses'
  | 'getChangeAddress'
  | 'getRewardAddresses'
  | 'getCollateral'
  | 'signTx'
  | 'signData'
  | 'submitTx';

export interface RpcRequest {
  target: typeof TARGET_CONTENT;
  id: string;
  method: RpcMethod;
  params: unknown[];
  /** Filled in by the content script from the page origin; never trusted from the page. */
  origin?: string;
}

export interface RpcResponse<T = unknown> {
  target: typeof TARGET_INPAGE;
  id: string;
  result?: T;
  // CIP-30 errors are `{ code, info }`; PaginateError is `{ maxSize }`.
  error?: { code: number; info: string } | { maxSize: number };
}

export function newId(): string {
  return crypto.randomUUID();
}
