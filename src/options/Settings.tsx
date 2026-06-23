// Settings page (T2.3): choose network + chain provider and enter its endpoint/credentials.
// Privileged options context. Credentials are user-scoped (Blockfrost key / Koios token / Ogmios URL),
// stored via the background in chrome.storage.local — NOT wallet key material. Rendered as text nodes.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { WalletSettings } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';
import type { ProviderKind } from '../background/provider/index';

const NETWORKS: Network[] = ['preview', 'preprod', 'mainnet'];
const PROVIDERS: ProviderKind[] = ['blockfrost', 'koios', 'ogmios'];

export function Settings() {
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
  const setBfKey = (v: string) =>
    patch({ blockfrostProjectIds: { ...s.blockfrostProjectIds, [s.network]: v } });

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      await wallet.updateSettings(s as WalletSettings);
      setStatus('Saved.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setStatus('Testing…');
    try {
      await wallet.updateSettings(s as WalletSettings); // test the config as edited
      const tip = await wallet.pingProvider();
      setStatus(`Connected ✓ tip slot ${tip.slot}, block ${tip.height}`);
    } catch (e) {
      setStatus(`Connection failed: ${e instanceof Error ? e.message : 'error'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={card}>
      <h1 style={{ fontSize: 20, marginTop: 0 }}>Settings</h1>

      <Label text="Network">
        <select value={s.network} onChange={(e) => patch({ network: e.target.value as Network })} style={input}>
          {NETWORKS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Label>

      <Label text="Chain provider">
        <select value={s.providerKind} onChange={(e) => patch({ providerKind: e.target.value as ProviderKind })} style={input}>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Label>

      {s.providerKind === 'blockfrost' && (
        <Label text={`Blockfrost project id (${s.network})`}>
          <input type="password" value={bfKey} autoComplete="off" placeholder={`${s.network}…`} onChange={(e) => setBfKey(e.target.value)} style={input} />
        </Label>
      )}

      {s.providerKind === 'koios' && (
        <Label text="Koios bearer token (optional)">
          <input type="password" value={s.koiosApiKey ?? ''} autoComplete="off" onChange={(e) => patch({ koiosApiKey: e.target.value })} style={input} />
        </Label>
      )}

      {s.providerKind === 'ogmios' && (
        <Label text="Ogmios URL (local node)">
          <input type="text" value={s.ogmiosUrl ?? ''} autoComplete="off" placeholder="ws://localhost:1337" onChange={(e) => patch({ ogmiosUrl: e.target.value })} style={input} />
        </Label>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" style={primary} disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" style={secondary} disabled={busy} onClick={() => void test()}>
          Test connection
        </button>
      </div>

      {status && <p style={{ fontSize: 13, marginTop: 12, color: '#2d3748' }}>{status}</p>}
    </section>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', margin: '12px 0' }}>
      <div style={{ fontSize: 13, color: '#444', marginBottom: 4 }}>{text}</div>
      {children}
    </label>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 20 };
const hint: React.CSSProperties = { fontSize: 13, color: '#4a5568' };
const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid #cbd5e0',
  borderRadius: 6,
};
const primary: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 14,
  fontWeight: 600,
  color: '#fff',
  background: '#2b6cb0',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const secondary: React.CSSProperties = { ...primary, color: '#2b6cb0', background: 'transparent', border: '1px solid #cbd5e0' };
