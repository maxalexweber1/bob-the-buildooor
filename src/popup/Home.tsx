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
  // Keep-alive tabs: a tab mounts on FIRST visit and then stays mounted, hidden via CSS. Switching
  // tabs must not unmount a view and throw away its loaded state (data, resolved asset names) —
  // that made every tab switch re-fetch everything. Lazy (visited-only) so opening the popup still
  // loads just the dashboard, not every view's chain data up-front.
  const [visited, setVisited] = useState<ReadonlySet<View>>(new Set<View>(['dashboard']));

  const open = (v: View) => {
    setVisited((prev) => (prev.has(v) ? prev : new Set(prev).add(v)));
    setView(v);
  };

  if (view === 'send') return <Send onBack={() => setView('dashboard')} />;

  const pane = (v: View): React.CSSProperties => ({ display: view === v ? 'block' : 'none' });

  return (
    <div>
      <div style={tabBar}>
        {TABS.map((t) => (
          <Tab key={t.id} label={t.label} active={view === t.id} onClick={() => open(t.id)} />
        ))}
      </div>
      {visited.has('dashboard') && (
        <div style={pane('dashboard')}>
          <Dashboard onSend={() => setView('send')} />
        </div>
      )}
      {visited.has('activity') && (
        <div style={pane('activity')}>
          <History />
        </div>
      )}
      {visited.has('utxos') && (
        <div style={pane('utxos')}>
          <Utxos />
        </div>
      )}
      {visited.has('provider') && (
        <div style={pane('provider')}>
          <ProviderSettings />
        </div>
      )}
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
