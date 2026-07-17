// Typed client for the internal wallet RPC (T1.7). Used by the popup and options pages only —
// both privileged extension contexts with chrome.runtime access. NEVER import this from inpage/content.
import {
  INTERNAL_TARGET,
  type InternalResult,
  type WalletCommand,
  type WalletStatus,
  type WalletOverview,
  type WalletSettings,
  type ChainTip,
  type BuiltTx,
  type SubmitResult,
  type PendingApproval,
  type HistoryEntry,
  type UtxoView,
  type TxStatus,
  type AssetMetadata,
  type ResolvedHandle,
  type HwAccountView,
  type HwBuiltTx,
  type HwWitness,
} from './internal';

async function send<T>(command: WalletCommand): Promise<T> {
  const res = (await chrome.runtime.sendMessage({
    target: INTERNAL_TARGET,
    command,
  })) as InternalResult | undefined;
  if (!res || res.ok !== true) {
    throw new Error(res?.ok === false ? res.error : 'wallet error');
  }
  return res.data as T;
}

export const wallet = {
  getStatus: () => send<WalletStatus>({ type: 'getStatus' }),
  create: (mnemonic: string, password: string) =>
    send<WalletStatus>({ type: 'create', mnemonic, password }),
  unlock: (password: string) => send<WalletStatus>({ type: 'unlock', password }),
  lock: () => send<WalletStatus>({ type: 'lock' }),
  getAddress: (index = 0) => send<string>({ type: 'getAddress', index }),
  getOverview: () => send<WalletOverview>({ type: 'getOverview' }),
  getSettings: () => send<WalletSettings>({ type: 'getSettings' }),
  updateSettings: (patch: Partial<WalletSettings>) =>
    send<WalletSettings>({ type: 'updateSettings', patch }),
  pingProvider: () => send<ChainTip>({ type: 'pingProvider' }),
  buildSend: (toAddress: string, lovelace: string, memo?: string) =>
    send<BuiltTx>({ type: 'buildSend', toAddress, lovelace, ...(memo !== undefined ? { memo } : {}) }),
  // CIP-113 programmable-token transfer (T9.5, experimental — needs cip113Params.transfer config).
  buildProgrammableSend: (unit: string, toAddress: string, quantity: string) =>
    send<BuiltTx>({ type: 'buildProgrammableSend', unit, toAddress, quantity }),
  approveSend: (id: string) => send<SubmitResult>({ type: 'approveSend', id }),
  cancelSend: () => send<void>({ type: 'cancelSend' }),
  getPendingApproval: (reqId: string) =>
    send<PendingApproval | null>({ type: 'getPendingApproval', reqId }),
  respondApproval: (reqId: string, approved: boolean) =>
    send<void>({ type: 'respondApproval', reqId, approved }),
  listConnectedDapps: () => send<string[]>({ type: 'listConnectedDapps' }),
  revokeDapp: (origin: string) => send<void>({ type: 'revokeDapp', origin }),
  getHistory: () => send<HistoryEntry[]>({ type: 'getHistory' }),
  listUtxos: () => send<UtxoView[]>({ type: 'listUtxos' }),
  getTxStatus: (txHash: string) => send<TxStatus>({ type: 'getTxStatus', txHash }),
  getAssetMetadata: (unit: string) => send<AssetMetadata | null>({ type: 'getAssetMetadata', unit }),
  getAssetImage: (uri: string) => send<string | null>({ type: 'getAssetImage', uri }),
  resolveHandle: (handle: string) => send<ResolvedHandle>({ type: 'resolveHandle', handle }),
  // ---- hardware wallets (T6.3) — device IO stays in the page, these commands only touch storage/chain ----
  hwListAccounts: () => send<HwAccountView[]>({ type: 'hwListAccounts' }),
  hwImportAccount: (kind: 'ledger' | 'trezor', xpub: string, label: string) =>
    send<HwAccountView>({ type: 'hwImportAccount', kind, xpub, label }),
  hwForgetAccount: (id: string) => send<void>({ type: 'hwForgetAccount', id }),
  hwOverview: (id: string) => send<WalletOverview>({ type: 'hwOverview', id }),
  hwBuildSend: (id: string, toAddress: string, lovelace: string, memo?: string) =>
    send<HwBuiltTx>({ type: 'hwBuildSend', id, toAddress, lovelace, ...(memo !== undefined ? { memo } : {}) }),
  hwCancelSend: () => send<void>({ type: 'hwCancelSend' }),
  hwSubmitSigned: (id: string, deviceTxHashHex: string, witnesses: HwWitness[]) =>
    send<SubmitResult>({ type: 'hwSubmitSigned', id, deviceTxHashHex, witnesses }),
  // Trezor: device IO runs in the SW via @trezor/connect-webextension (its supported context) —
  // these two commands trigger the Trezor popup from there.
  hwTrezorPair: () => send<HwAccountView>({ type: 'hwTrezorPair' }),
  hwTrezorSign: (id: string) => send<SubmitResult>({ type: 'hwTrezorSign', id }),
};
