// Popup state (T1.7). chrome.storage (via the background) is the source of truth; this store just
// mirrors the wallet status for routing + holds transient UI error text. No secrets are kept here.
import { create } from 'zustand';
import { wallet } from '../shared/walletClient';
import type { WalletStatus } from '../shared/internal';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

interface WalletState {
  status: WalletStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  unlock: (password: string) => Promise<boolean>;
  lock: () => Promise<void>;
}

export const useWallet = create<WalletState>((set) => ({
  status: null,
  loading: true,
  error: null,
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      set({ status: await wallet.getStatus(), loading: false });
    } catch (e) {
      set({ error: errMessage(e), loading: false });
    }
  },
  unlock: async (password) => {
    set({ error: null });
    try {
      set({ status: await wallet.unlock(password) });
      return true;
    } catch (e) {
      set({ error: errMessage(e) });
      return false;
    }
  },
  lock: async () => {
    try {
      set({ status: await wallet.lock(), error: null });
    } catch (e) {
      set({ error: errMessage(e) });
    }
  },
}));
