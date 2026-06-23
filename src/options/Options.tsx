// Options-page router: show onboarding until a wallet exists, then the settings page.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { WalletStatus } from '../shared/internal';
import { Onboarding } from './Onboarding';
import { Settings } from './Settings';

export function Options() {
  const [status, setStatus] = useState<WalletStatus | null>(null);

  useEffect(() => {
    void wallet.getStatus().then(setStatus).catch(() => setStatus({ initialized: false, unlocked: false }));
  }, []);

  if (!status) return <p style={{ fontSize: 13, color: '#4a5568' }}>Loading…</p>;
  return status.initialized ? <Settings /> : <Onboarding />;
}
