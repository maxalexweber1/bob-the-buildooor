// Read-only dashboard (T2.5): live balance, native assets, receive address, network switch.
// All chain/asset strings rendered as React text nodes only (CLAUDE.md §1.8). Privileged context.
import { useCallback, useEffect, useState } from 'react';
import { useWallet } from './store';
import { wallet } from '../shared/walletClient';
import type { WalletOverview } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';
import { primaryButton } from './App';

const NETWORKS: Network[] = ['preview', 'preprod', 'mainnet'];

function formatAda(lovelace: string): string {
  const v = BigInt(lovelace);
  const ada = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${ada}.${frac}` : ada.toString();
}

export function Dashboard({ onSend }: { onSend: () => void }) {
  const { lock } = useWallet();
  const [overview, setOverview] = useState<WalletOverview | null>(null);
  const [network, setNetwork] = useState<Network>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
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

      {error && <p style={{ color: '#c53030', fontSize: 13 }}>{error}</p>}

      <div style={{ fontSize: 12, color: '#718096' }}>Balance</div>
      <div style={{ fontSize: 28, fontWeight: 700, margin: '2px 0 16px' }}>
        {loading && !overview ? '…' : overview ? `${formatAda(overview.balance.lovelace)} ₳` : '—'}
      </div>

      {overview && overview.balance.assets.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#718096', marginBottom: 4 }}>
            Assets ({overview.balance.assets.length})
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 120, overflowY: 'auto' }}>
            {overview.balance.assets.map((a) => (
              <li key={a.unit} style={assetRow}>
                <span style={{ fontSize: 12 }}>{a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`}</span>
                <span style={{ fontSize: 12, color: '#4a5568' }}>{a.quantity}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ fontSize: 12, color: '#718096' }}>Receive address</div>
      <code style={addressBox}>{overview?.receiveAddress ?? '…'}</code>

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
  justifyContent: 'space-between',
  padding: '3px 0',
  borderBottom: '1px solid #edf2f7',
};
const addressBox: React.CSSProperties = {
  display: 'block',
  wordBreak: 'break-all',
  fontSize: 11,
  background: '#f7fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: 8,
  margin: '4px 0 16px',
};
