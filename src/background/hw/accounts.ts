// Hardware-account store (EXECUTION_PLAN T6.3). Persists the account-level xpubs of paired hardware
// wallets in chrome.storage.local. An xpub is NOT secret material (it cannot spend), but it is
// privacy-sensitive (it derives every address of the account) — it stays in extension storage and is
// only ever handed to privileged pages, never across the dApp bridge.
import { chromeLocalStore, type KeyValueStore } from '../storage';
import { parseAccountXpub } from '../../core/hw/xpubAccount';

export interface HwAccount {
  id: string;
  kind: 'ledger' | 'trezor';
  label: string;
  /** Account-level extended public key: publicKey || chainCode, 128 hex chars. */
  xpub: string;
  createdAt: number;
}

const STORE_KEY = 'bob:hwAccounts';

export class HwAccounts {
  constructor(private readonly store: KeyValueStore = chromeLocalStore) {}

  async list(): Promise<HwAccount[]> {
    return (await this.store.get<HwAccount[]>(STORE_KEY)) ?? [];
  }

  async get(id: string): Promise<HwAccount> {
    const account = (await this.list()).find((a) => a.id === id);
    if (!account) throw new Error('unknown hardware account');
    return account;
  }

  /** Add a paired device account. Validates the xpub; re-importing the same xpub is idempotent. */
  async add(kind: HwAccount['kind'], xpub: string, label: string): Promise<HwAccount> {
    parseAccountXpub(xpub); // throws on malformed input — device data is not trusted blindly
    const accounts = await this.list();
    const existing = accounts.find((a) => a.xpub.toLowerCase() === xpub.toLowerCase());
    if (existing) return existing;

    const account: HwAccount = {
      id: crypto.randomUUID(),
      kind,
      label: label.trim().slice(0, 40) || (kind === 'trezor' ? 'Trezor' : 'Ledger'),
      xpub: xpub.toLowerCase(),
      createdAt: Date.now(),
    };
    await this.store.set(STORE_KEY, [...accounts, account]);
    return account;
  }

  async remove(id: string): Promise<void> {
    const accounts = await this.list();
    await this.store.set(
      STORE_KEY,
      accounts.filter((a) => a.id !== id),
    );
  }
}

export const hwAccounts = new HwAccounts();
