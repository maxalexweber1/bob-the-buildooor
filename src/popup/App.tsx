// Popup shell + router (T1.7). Privileged context (has chrome.*). Render untrusted strings only via
// React text nodes — never dangerouslySetInnerHTML (CLAUDE.md §1.8).
import { useEffect } from 'react';
import { useWallet } from './store';
import { Unlock } from './Unlock';
import { Home } from './Home';
import { Connect } from './Connect';

export function App() {
  const { status, loading, refresh } = useWallet();

  // Opened as a popup window by the background for a dApp approval prompt (#approve).
  const isApproval = typeof window !== 'undefined' && window.location.hash.startsWith('#approve');

  useEffect(() => {
    if (!isApproval) void refresh();
  }, [refresh, isApproval]);

  if (isApproval) return <Connect />;

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>bob-the-buildooor</h1>
      {loading || !status ? (
        <p style={{ color: '#666', fontSize: 13 }}>Loading…</p>
      ) : !status.initialized ? (
        <NoWallet />
      ) : !status.unlocked ? (
        <Unlock />
      ) : (
        <Home />
      )}
    </main>
  );
}

function NoWallet() {
  return (
    <div>
      <p style={{ fontSize: 13, color: '#444' }}>
        No wallet yet. Create a new wallet or restore one from a seed phrase.
      </p>
      <button
        type="button"
        style={primaryButton}
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        Create or restore wallet
      </button>
    </div>
  );
}

export const primaryButton: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  fontWeight: 600,
  color: '#fff',
  background: '#2b6cb0',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
