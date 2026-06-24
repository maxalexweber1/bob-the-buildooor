// Read-only dashboard (T2.5): live balance, native assets, receive address, provider status, network
// switch. All chain/asset strings render as React text nodes only (CLAUDE.md §1.8). Privileged context.
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from './store';
import { wallet } from '../shared/walletClient';
import type { WalletOverview } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';
import { primaryButton } from './App';
import { formatAda, shortId, TokenAvatar, ProviderBadge, card } from './ui';

const NETWORKS: Network[] = ['preview', 'preprod', 'mainnet'];

export function Dashboard({ onSend }: { onSend: () => void }) {
  const { lock } = useWallet();
  const [overview, setOverview] = useState<WalletOverview | null>(null);
  const [network, setNetwork] = useState<Network>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNetwork((await wallet.getSettings()).network);
      setOverview(await wallet.getOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeNetwork(n: Network) {
    setLoading(true);
    setError(null);
    try {
      await wallet.updateSettings({ network: n });
      setNetwork(n);
      setOverview(await wallet.getOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch network');
    } finally {
      setLoading(false);
    }
  }

  async function copyAddress() {
    if (!overview) return;
    try {
      await navigator.clipboard.writeText(overview.receiveAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: '#2f855a' }}>● Unlocked</span>
        <select
          value={network}
          onChange={(e) => void changeNetwork(e.target.value as Network)}
          disabled={loading}
          style={{ fontSize: 12, padding: '2px 4px' }}
        >
          {NETWORKS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <ProviderBadge />
      </div>

      {error && <p style={{ color: '#c53030', fontSize: 13 }}>{error}</p>}

      <div style={{ ...card, background: 'linear-gradient(135deg,#2b6cb0,#2c5282)', border: 'none', color: '#fff' }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Total balance</div>
        <div style={{ fontSize: 30, fontWeight: 700, margin: '2px 0' }}>
          {loading && !overview ? '…' : overview ? `${formatAda(overview.balance.lovelace)} ₳` : '—'}
        </div>
      </div>

      {overview && overview.balance.assets.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: '#718096', marginBottom: 6 }}>
            Assets ({overview.balance.assets.length})
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 160, overflowY: 'auto' }}>
            {overview.balance.assets.map((a) => {
              const name = a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
              return (
                <li key={a.unit} style={assetRow}>
                  <TokenAvatar policyId={a.policyId} label={name} />
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                  <span style={{ fontSize: 13, color: '#4a5568' }}>{a.quantity}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: '#718096' }}>Receive address</span>
          <button type="button" onClick={() => void copyAddress()} style={copyBtn}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <code style={{ fontSize: 11, wordBreak: 'break-all', color: '#2d3748' }} title={overview?.receiveAddress}>
          {overview ? shortId(overview.receiveAddress, 16) : '…'}
        </code>
      </div>

      <button type="button" style={{ ...primaryButton, width: '100%', marginBottom: 8 }} onClick={onSend}>
        Send
      </button>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={{ ...primaryButton, flex: 1, background: '#4a5568' }} disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <button type="button" style={{ ...primaryButton, flex: 1, background: '#4a5568' }} onClick={() => void lock()}>
          Lock
        </button>
      </div>
    </div>
  );
}

const assetRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 0',
  borderBottom: '1px solid #edf2f7',
};
const copyBtn: React.CSSProperties = {
  fontSize: 11,
  color: '#2b6cb0',
  background: 'transparent',
  border: '1px solid #cbd5e0',
  borderRadius: 5,
  padding: '2px 8px',
  cursor: 'pointer',
};
