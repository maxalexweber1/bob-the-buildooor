// Options-page router: a Wallet view (onboarding until a vault exists, then settings) plus the
// Ledger hardware-wallet manager (T6.3). Ledger is deliberately reachable WITHOUT a hot wallet —
// a hardware-only user never creates a vault, so it can't sit behind the onboarding gate.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { WalletStatus } from '../shared/internal';
import { Onboarding } from './Onboarding';
import { Settings } from './Settings';
import { Ledger } from './Ledger';

type Tab = 'wallet' | 'ledger';

export function Options() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [tab, setTab] = useState<Tab>('wallet');

  useEffect(() => {
    void wallet.getStatus().then(setStatus).catch(() => setStatus({ initialized: false, unlocked: false }));
  }, []);

  if (!status) return <p style={{ fontSize: 13, color: '#4a5568' }}>Loading…</p>;

  return (
    <div>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button type="button" style={tab === 'wallet' ? tabActive : tabIdle} onClick={() => setTab('wallet')}>
          Wallet
        </button>
        <button type="button" style={tab === 'ledger' ? tabActive : tabIdle} onClick={() => setTab('ledger')}>
          Hardware
        </button>
      </nav>
      {tab === 'ledger' ? <Ledger /> : status.initialized ? <Settings /> : <Onboarding />}
    </div>
  );
}

const tabIdle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#4a5568',
  background: 'transparent',
  border: '1px solid #cbd5e0',
  borderRadius: 6,
  padding: '6px 14px',
  cursor: 'pointer',
};
const tabActive: React.CSSProperties = { ...tabIdle, color: '#fff', background: '#2b6cb0', border: 'none' };
