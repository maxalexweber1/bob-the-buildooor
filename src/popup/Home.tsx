// Unlocked-wallet shell: a tab bar (Dashboard / Activity / UTxOs / Provider), with Send pushed as a
// full view (and a Back). Each tab is a self-contained, read-only view except Provider (settings).
import { useState } from 'react';
import { Dashboard } from './Dashboard';
import { History } from './History';
import { Utxos } from './Utxos';
import { ProviderSettings } from './ProviderSettings';
import { Send } from './Send';

type View = 'dashboard' | 'activity' | 'utxos' | 'provider' | 'send';

const TABS: Array<{ id: Exclude<View, 'send'>; label: string }> = [
  { id: 'dashboard', label: 'Wallet' },
  { id: 'activity', label: 'Activity' },
  { id: 'utxos', label: 'UTxOs' },
  { id: 'provider', label: 'Provider' },
];

export function Home() {
  const [view, setView] = useState<View>('dashboard');

  if (view === 'send') return <Send onBack={() => setView('dashboard')} />;

  return (
    <div>
      <div style={tabBar}>
        {TABS.map((t) => (
          <Tab key={t.id} label={t.label} active={view === t.id} onClick={() => setView(t.id)} />
        ))}
      </div>
      {view === 'dashboard' && <Dashboard onSend={() => setView('send')} />}
      {view === 'activity' && <History />}
      {view === 'utxos' && <Utxos />}
      {view === 'provider' && <ProviderSettings />}
    </div>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: '8px 0',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        color: active ? '#2b6cb0' : '#718096',
        background: 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid #2b6cb0' : '2px solid transparent',
      }}
    >
      {label}
    </button>
  );
}

const tabBar: React.CSSProperties = {
  display: 'flex',
  gap: 2,
  borderBottom: '1px solid #e2e8f0',
  marginBottom: 12,
};
