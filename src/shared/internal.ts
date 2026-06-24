// Internal popup/options ⇄ background protocol (T1.7). DISTINCT from the dApp CIP-30 bridge
// (shared/messages.ts): these commands are PRIVILEGED (create/unlock/derive) and must only ever be
// accepted from trusted extension pages — never from a content script / dApp. The background enforces
// that with a sender check (CLAUDE.md §1.4/§1.6). This module is imported only by privileged contexts.

import type { WalletSettings } from '../background/settings';
import type { WalletBalance } from '../core/balance';
import type { Network, ChainTip } from '../background/provider/IChainProvider';
import type { TxSummary } from '../core/tx/summary';
import type { PendingApproval } from '../background/dapp/approvals';

export type { ChainTip, TxSummary, PendingApproval };

/** Result of building a send: an id binding the approval to the exact decoded summary shown. */
export interface BuiltTx {
  id: string;
  summary: TxSummary;
}
export interface SubmitResult {
  txHash: string;
}

export type TxStatus = 'confirmed' | 'pending' | 'unknown';

export const INTERNAL_TARGET = 'bob:internal' as const;

export interface WalletStatus {
  initialized: boolean;
  unlocked: boolean;
}

/** Read-only wallet snapshot for the dashboard (T2.5). */
export interface WalletOverview {
  network: Network;
  receiveAddress: string;
  usedExternal: number;
  usedChange: number;
  balance: WalletBalance;
}

export type { WalletSettings };

export type WalletCommand =
  | { type: 'getStatus' }
  | { type: 'create'; mnemonic: string; password: string }
  | { type: 'unlock'; password: string }
  | { type: 'lock' }
  | { type: 'getAddress'; index: number }
  | { type: 'getOverview' }
  | { type: 'getSettings' }
  | { type: 'updateSettings'; patch: Partial<WalletSettings> }
  | { type: 'pingProvider' }
  | { type: 'buildSend'; toAddress: string; lovelace: string }
  | { type: 'approveSend'; id: string }
  | { type: 'cancelSend' }
  | { type: 'getPendingApproval'; reqId: string }
  | { type: 'respondApproval'; reqId: string; approved: boolean }
  | { type: 'listConnectedDapps' }
  | { type: 'revokeDapp'; origin: string }
  | { type: 'getTxStatus'; txHash: string };

export interface InternalRequest {
  target: typeof INTERNAL_TARGET;
  command: WalletCommand;
}

export type InternalResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export function isInternalRequest(msg: unknown): msg is InternalRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { target?: unknown }).target === INTERNAL_TARGET
  );
}
