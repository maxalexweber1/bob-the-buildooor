// Activity / transaction history (read-only). Aggregates the wallet's net effect per tx over all its
// HD addresses (computed in core/tx/history). All chain strings render as text nodes (CLAUDE.md §1.8);
// the explorer link opens cardanoscan in a new tab.
import { useCallback, useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { HistoryEntry } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';
import { formatAdaSigned, explorerTxUrl, shortId, relativeTime, TokenAvatar, card } from './ui';

export function History() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [network, setNetwork] = useState<Network>('preview');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNetwork((await wallet.getSettings()).network);
      setEntries(await wallet.getHistory());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !entries) return <p style={hint}>Loading activity…</p>;
  if (error) {
    return (
      <div>
        <p style={{ ...hint, color: '#c05621' }}>{error}</p>
        <button type="button" style={refresh} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!entries || entries.length === 0) return <p style={hint}>No transactions yet.</p>;

  return (
    <div>
      {entries.map((e) => (
        <Row key={e.txHash} e={e} network={network} />
      ))}
      <button type="button" style={refresh} disabled={loading} onClick={() => void load()}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}

function Row({ e, network }: { e: HistoryEntry; network: Network }) {
  const inbound = e.direction === 'in';
  const icon = e.direction === 'in' ? '↓' : e.direction === 'out' ? '↑' : '↻';
  const color = e.direction === 'in' ? '#2f855a' : e.direction === 'out' ? '#c53030' : '#4a5568';
  const verb = e.direction === 'in' ? 'Received' : e.direction === 'out' ? 'Sent' : 'Self-transfer';
  const party = e.counterparties[0];

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 28, height: 28, minWidth: 28, borderRadius: '50%', background: `${color}1a`, color, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{verb}</div>
          <div style={{ fontSize: 11, color: '#718096' }}>{relativeTime(e.blockTime)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, color }}>{formatAdaSigned(e.netLovelace)}</div>
          {e.fee && !inbound && <div style={{ fontSize: 11, color: '#a0aec0' }}>fee {formatAdaSigned(`-${e.fee}`).replace('−', '')}</div>}
        </div>
      </div>

      {e.netAssets.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {e.netAssets.map((a) => {
            const name = a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
            return (
              <div key={a.unit} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <TokenAvatar policyId={a.policyId} label={name} size={18} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                <span style={{ color: a.quantity.startsWith('-') ? '#c53030' : '#2f855a' }}>{a.quantity}</span>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: '#718096' }}>
        {party ? <span title={party}>{e.direction === 'in' ? 'from' : 'to'} {shortId(party, 10)}</span> : <span />}
        <a href={explorerTxUrl(network, e.txHash)} target="_blank" rel="noreferrer" style={{ color: '#2b6cb0', textDecoration: 'none' }}>
          {shortId(e.txHash)} ↗
        </a>
      </div>
    </div>
  );
}

const hint: React.CSSProperties = { fontSize: 13, color: '#4a5568' };
const refresh: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#4a5568',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
