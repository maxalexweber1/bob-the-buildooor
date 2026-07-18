// Popup state (T1.7). chrome.storage (via the background) is the source of truth; this store just
// mirrors the wallet status for routing + holds transient UI error text, plus a popup-lifetime
// stale-while-revalidate cache of the read-only view data. No secrets are kept here — balances,
// history and UTxOs are public chain data.
import { create } from 'zustand';
import { wallet } from '../shared/walletClient';
import type { WalletStatus, WalletOverview, HistoryEntry, UtxoView } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

// ---- View data (stale-while-revalidate) ----
// Each slice keeps its last good `data` visible while a refresh runs, so switching tabs (or coming
// back from Send) paints instantly instead of flashing "Loading…". A failed refresh keeps the stale
// data on screen and carries the error alongside it. The store dies with the popup; cross-popup
// caching lives in the background (walletHandlers' TTL caches).

/** One cached view slice: render `data` if present; `refreshing` drives subtle refresh UI. */
export interface Slice<T> {
  data: T | null;
  refreshing: boolean;
  error: string | null;
}

const emptySlice = <T,>(): Slice<T> => ({ data: null, refreshing: false, error: null });

interface WalletDataState {
  /** Active network — refreshed with every load; views need it for explorer links. */
  network: Network;
  setNetwork: (n: Network) => void;
  overview: Slice<WalletOverview>;
  history: Slice<HistoryEntry[]>;
  utxos: Slice<UtxoView[]>;
  loadOverview: () => Promise<void>;
  loadHistory: () => Promise<void>;
  loadUtxos: () => Promise<void>;
  /** Drop everything (network switch, submitted tx, lock) — stale data must not render as current. */
  invalidate: () => void;
}

export const useWalletData = create<WalletDataState>((set, get) => ({
  network: 'preview',
  setNetwork: (n) => set({ network: n }),
  overview: emptySlice<WalletOverview>(),
  history: emptySlice<HistoryEntry[]>(),
  utxos: emptySlice<UtxoView[]>(),

  loadOverview: async () => {
    if (get().overview.refreshing) return; // one in-flight refresh per slice
    set((s) => ({ overview: { ...s.overview, refreshing: true, error: null } }));
    try {
      const [settings, data] = await Promise.all([wallet.getSettings(), wallet.getOverview()]);
      set({ network: settings.network, overview: { data, refreshing: false, error: null } });
    } catch (e) {
      set((s) => ({ overview: { data: s.overview.data, refreshing: false, error: errMessage(e) } }));
    }
  },

  loadHistory: async () => {
    if (get().history.refreshing) return;
    set((s) => ({ history: { ...s.history, refreshing: true, error: null } }));
    try {
      const [settings, data] = await Promise.all([wallet.getSettings(), wallet.getHistory()]);
      set({ network: settings.network, history: { data, refreshing: false, error: null } });
    } catch (e) {
      set((s) => ({ history: { data: s.history.data, refreshing: false, error: errMessage(e) } }));
    }
  },

  loadUtxos: async () => {
    if (get().utxos.refreshing) return;
    set((s) => ({ utxos: { ...s.utxos, refreshing: true, error: null } }));
    try {
      const [settings, data] = await Promise.all([wallet.getSettings(), wallet.listUtxos()]);
      set({ network: settings.network, utxos: { data, refreshing: false, error: null } });
    } catch (e) {
      set((s) => ({ utxos: { data: s.utxos.data, refreshing: false, error: errMessage(e) } }));
    }
  },

  invalidate: () =>
    set({ overview: emptySlice(), history: emptySlice(), utxos: emptySlice() }),
}));

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
      useWalletData.getState().invalidate(); // no cached balances behind the unlock screen
    } catch (e) {
      set({ error: errMessage(e) });
    }
  },
}));
