// Provider selection in the popup (compact mirror of the options Settings page): pick network +
// chain provider + endpoint/credentials and save. Credentials are user config (NOT key material),
// persisted via the background in chrome.storage.local. All strings render as text nodes (§1.8).
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { WalletSettings } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';
import type { HistoryBackend, ProviderKind } from '../background/provider/index';
import { ProviderBadge, card } from './ui';
import { ensureHostPermission } from '../shared/providerPermissions';
import { useWalletData } from './store';

const NETWORKS: Network[] = ['preview', 'preprod', 'mainnet'];
const PROVIDERS: ProviderKind[] = ['blockfrost', 'koios', 'ogmios'];

export function ProviderSettings() {
  const [s, setS] = useState<WalletSettings | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    wallet
      .getSettings()
      .then(setS)
      .catch((e: unknown) => setStatus(e instanceof Error ? e.message : 'Failed to load settings'));
  }, []);

  if (!s) return <p style={hint}>Loading…</p>;

  const patch = (p: Partial<WalletSettings>) => setS({ ...s, ...p });
  const bfKey = s.blockfrostProjectIds?.[s.network] ?? '';
  const setBfKey = (v: string) => patch({ blockfrostProjectIds: { ...s.blockfrostProjectIds, [s.network]: v } });

  async function save(testAfter = false) {
    if (!s) return;
    // Custom provider hosts (self-hosted Koios / Kupo) need a runtime host permission before the SW
    // can fetch them — request FIRST, while this click's user gesture is still active, and treat a
    // denial as a visible failure, not a silent save (shared helper).
    if ((s.providerKind === 'koios' || s.historyBackend === 'koios') && !(await ensureHostPermission(s.koiosUrl))) {
      setStatus('Permission for the custom Koios host was denied — it cannot be used.');
      return;
    }
    if (s.providerKind === 'ogmios' && !(await ensureHostPermission(s.kupoUrl))) {
      setStatus('Permission for the Kupo host was denied — it cannot be used.');
      return;
    }
    setBusy(true);
    setStatus(testAfter ? 'Testing…' : null);
    try {
      await wallet.updateSettings(s as WalletSettings);
      // Network/provider changed → every cached view (balance, history, UTxOs) is potentially for
      // the wrong network. Drop them; the views refetch on next visit.
      useWalletData.getState().invalidate();
      if (testAfter) {
        const tip = await wallet.pingProvider();
        setStatus(`Connected ✓ tip slot ${tip.slot}, block ${tip.height}`);
      } else {
        setStatus('Saved.');
      }
    } catch (e) {
      setStatus(`${testAfter ? 'Connection failed' : 'Save failed'}: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <ProviderBadge />
      </div>

      <div style={card}>
        <Field label="Network">
          <select value={s.network} onChange={(e) => patch({ network: e.target.value as Network })} style={input}>
            {NETWORKS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Chain provider">
          <select value={s.providerKind} onChange={(e) => patch({ providerKind: e.target.value as ProviderKind })} style={input}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        {(s.providerKind === 'blockfrost' || s.historyBackend === 'blockfrost') && (
          <Field label={`Blockfrost project id (${s.network})`}>
            <input type="password" value={bfKey} autoComplete="off" placeholder={`${s.network}…`} onChange={(e) => setBfKey(e.target.value)} style={input} />
          </Field>
        )}
        {s.providerKind === 'koios' && (
          <>
            <Field label="Koios URL (optional — self-hosted; blank = public)">
              <input type="text" value={s.koiosUrl ?? ''} autoComplete="off" placeholder="https://preview.koios.rest/api/v1" onChange={(e) => patch({ koiosUrl: e.target.value })} style={input} />
            </Field>
            <Field label="Koios bearer token (optional)">
              <input type="password" value={s.koiosApiKey ?? ''} autoComplete="off" onChange={(e) => patch({ koiosApiKey: e.target.value })} style={input} />
            </Field>
          </>
        )}
        {s.providerKind === 'ogmios' && (
          <>
            <Field label="Ogmios URL (local node)">
              <input type="text" value={s.ogmiosUrl ?? ''} autoComplete="off" placeholder="ws://localhost:1337" onChange={(e) => patch({ ogmiosUrl: e.target.value })} style={input} />
            </Field>
            <Field label="Kupo URL (indexed UTxOs — recommended)">
              <input type="text" value={s.kupoUrl ?? ''} autoComplete="off" placeholder="http://localhost:1442" onChange={(e) => patch({ kupoUrl: e.target.value })} style={input} />
            </Field>
            <Field label="History & token metadata (dual mode)">
              <select
                value={s.historyBackend ?? ''}
                onChange={(e) => patch({ historyBackend: (e.target.value || undefined) as HistoryBackend | undefined })}
                style={input}
              >
                <option value="">None (local only)</option>
                <option value="blockfrost">Blockfrost</option>
                <option value="koios">Koios</option>
              </select>
            </Field>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={primary} disabled={busy} onClick={() => void save(false)}>
          Save
        </button>
        <button type="button" style={secondary} disabled={busy} onClick={() => void save(true)}>
          Save & test
        </button>
      </div>
      {status && <p style={{ fontSize: 12, marginTop: 10, color: '#2d3748' }}>{status}</p>}
      {s.providerKind === 'ogmios' && !s.historyBackend && (
        <p style={{ fontSize: 11, color: '#a0aec0', marginTop: 8 }}>
          Ogmios has no transaction history or token metadata — set “History &amp; token metadata” to
          Blockfrost or Koios for Activity, token names and ADA Handles.
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', margin: '0 0 10px' }}>
      <div style={{ fontSize: 12, color: '#718096', marginBottom: 4 }}>{label}</div>
      {children}
    </label>
  );
}

const hint: React.CSSProperties = { fontSize: 13, color: '#4a5568' };
const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 9px',
  fontSize: 13,
  border: '1px solid #cbd5e0',
  borderRadius: 6,
};
const primary: React.CSSProperties = {
  flex: 1,
  padding: '9px 12px',
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#2b6cb0',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const secondary: React.CSSProperties = { ...primary, color: '#2b6cb0', background: 'transparent', border: '1px solid #cbd5e0' };
