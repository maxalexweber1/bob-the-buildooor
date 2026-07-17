// Internal popup/options ⇄ background protocol (T1.7). DISTINCT from the dApp CIP-30 bridge
// (shared/messages.ts): these commands are PRIVILEGED (create/unlock/derive) and must only ever be
// accepted from trusted extension pages — never from a content script / dApp. The background enforces
// that with a sender check (CLAUDE.md §1.4/§1.6). This module is imported only by privileged contexts.

import type { WalletSettings } from '../background/settings';
import type { WalletBalance } from '../core/balance';
import type { Network, ChainTip, AssetMetadata } from '../background/provider/IChainProvider';
import type { TxSummary } from '../core/tx/summary';
import type { HistoryEntry } from '../core/tx/history';
import type { PendingApproval } from '../background/dapp/approvals';
import type { ResolvedHandle } from '../core/handle';
import type { LedgerTxPayload, HwWitness } from '../core/hw/ledgerTx';

export type { ChainTip, TxSummary, HistoryEntry, PendingApproval, AssetMetadata, ResolvedHandle };
export type { LedgerTxPayload, HwWitness };

/** A paired hardware account as shown to the UI (the xpub itself stays in the background store). */
export interface HwAccountView {
  id: string;
  kind: 'ledger' | 'trezor';
  label: string;
  createdAt: number;
}

/** Result of building a hardware send: summary for the review screen + the device signing payload. */
export interface HwBuiltTx {
  id: string;
  summary: TxSummary;
  ledgerTx: LedgerTxPayload;
}

/** Result of building a send: an id binding the approval to the exact decoded summary shown. */
export interface BuiltTx {
  id: string;
  summary: TxSummary;
}
export interface SubmitResult {
  txHash: string;
}

export type TxStatus = 'confirmed' | 'pending' | 'unknown';

/** A single unspent output the wallet controls (across its HD addresses). */
export interface UtxoView {
  txHash: string;
  outputIndex: number;
  address: string;
  value: WalletBalance;
}

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
  /**
   * CIP-113 programmable tokens owned by this wallet's credentials (T9.2) — held at the shared
   * programmable-logic script address, NOT at our base addresses. Kept separate from `balance` on
   * purpose: these are not vkey-spendable, must never enter coin selection or the dApp-facing
   * CIP-30 getBalance/getUtxos, and are display-only until transfer support lands (M9 gate).
   * Present only when CIP-113 params are configured for the active network.
   */
  programmable?: WalletBalance;
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
  | { type: 'buildSend'; toAddress: string; lovelace: string; memo?: string }
  | { type: 'approveSend'; id: string }
  | { type: 'cancelSend' }
  | { type: 'getPendingApproval'; reqId: string }
  | { type: 'respondApproval'; reqId: string; approved: boolean }
  | { type: 'listConnectedDapps' }
  | { type: 'revokeDapp'; origin: string }
  | { type: 'getHistory' }
  | { type: 'listUtxos' }
  | { type: 'getTxStatus'; txHash: string }
  | { type: 'getAssetMetadata'; unit: string }
  | { type: 'getAssetImage'; uri: string }
  | { type: 'resolveHandle'; handle: string }
  | { type: 'hwListAccounts' }
  | { type: 'hwImportAccount'; kind: 'ledger' | 'trezor'; xpub: string; label: string }
  | { type: 'hwForgetAccount'; id: string }
  | { type: 'hwOverview'; id: string }
  | { type: 'hwBuildSend'; id: string; toAddress: string; lovelace: string; memo?: string }
  | { type: 'hwCancelSend' }
  | { type: 'hwSubmitSigned'; id: string; deviceTxHashHex: string; witnesses: HwWitness[] }
  | { type: 'hwTrezorPair' }
  | { type: 'hwTrezorSign'; id: string };

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
