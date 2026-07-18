// UTxO list (read-only): every unspent output the wallet controls across its HD addresses. Useful for
// debugging coin selection / collateral. All chain strings render as text nodes (CLAUDE.md §1.8).
import { useEffect } from 'react';
import { useWalletData } from './store';
import { formatAda, explorerTxUrl, shortId, TokenAvatar, card } from './ui';

export function Utxos() {
  // Stale-while-revalidate (store.ts): last loaded UTxOs render instantly; refresh runs quietly.
  const { network, utxos: slice, loadUtxos: load } = useWalletData();
  const utxos = slice.data;
  const loading = slice.refreshing;
  const error = slice.error;

  // Self-healing load: first mount + whenever the slice is invalidated. `!error` stops retry loops.
  useEffect(() => {
    if (!utxos && !loading && !error) void load();
  }, [utxos, loading, error, load]);

  if (loading && !utxos) return <p style={hint}>Loading UTxOs…</p>;
  if (error && !utxos) {
    return (
      <div>
        <p style={{ ...hint, color: '#c05621' }}>{error}</p>
        <button type="button" style={refresh} onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!utxos || utxos.length === 0) return <p style={hint}>No UTxOs.</p>;

  const totalLovelace = utxos.reduce((acc, u) => acc + BigInt(u.value.lovelace), 0n).toString();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: '#4a5568' }}>
          {utxos.length} UTxO{utxos.length === 1 ? '' : 's'}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{formatAda(totalLovelace)} ₳</span>
      </div>

      {utxos.map((u) => (
        <div key={`${u.txHash}#${u.outputIndex}`} style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <a
              href={explorerTxUrl(network, u.txHash)}
              target="_blank"
              rel="noreferrer"
              title={`${u.txHash}#${u.outputIndex}`}
              style={{ fontSize: 12, color: '#2b6cb0', textDecoration: 'none', fontFamily: 'monospace' }}
            >
              {shortId(u.txHash, 8)}#{u.outputIndex} ↗
            </a>
            <span style={{ fontWeight: 700 }}>{formatAda(u.value.lovelace)} ₳</span>
          </div>

          {u.value.assets.length > 0 && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {u.value.assets.map((a) => {
                const name = a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
                return (
                  <div key={a.unit} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <TokenAvatar policyId={a.policyId} label={name} size={18} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                    <span style={{ color: '#4a5568' }}>{a.quantity}</span>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 6, fontSize: 11, color: '#a0aec0' }} title={u.address}>
            at {shortId(u.address, 12)}
          </div>
        </div>
      ))}

      <button type="button" style={refresh} disabled={loading} onClick={() => void load()}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
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
