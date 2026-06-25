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
};
