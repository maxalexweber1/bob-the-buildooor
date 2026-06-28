// Settings page (T2.3): choose network + chain provider and enter its endpoint/credentials.
// Privileged options context. Credentials are user-scoped (Blockfrost key / Koios token / Ogmios URL),
// stored via the background in chrome.storage.local — NOT wallet key material. Rendered as text nodes.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { WalletSettings } from '../shared/internal';
import type { Network } from '../background/provider/IChainProvider';
import type { HistoryBackend, ProviderKind } from '../background/provider/index';

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

      {(s.providerKind === 'blockfrost' || s.historyBackend === 'blockfrost') && (
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
        <>
          <Label text="Ogmios URL (local node)">
            <input type="text" value={s.ogmiosUrl ?? ''} autoComplete="off" placeholder="ws://localhost:1337" onChange={(e) => patch({ ogmiosUrl: e.target.value })} style={input} />
          </Label>
          <Label text="Kupo URL (recommended for Ogmios)">
            <input type="text" value={s.kupoUrl ?? ''} autoComplete="off" placeholder="http://localhost:1442" onChange={(e) => patch({ kupoUrl: e.target.value })} style={input} />
          </Label>
          <p style={{ ...hint, marginTop: 0 }}>
            Ogmios has no address index, so balance/discovery is very slow without Kupo. Run Kupo
            alongside your node and set its URL here — address lookups then resolve instantly. Leave
            blank to use Ogmios alone (slow).
          </p>
          <Label text="History &amp; token metadata (dual mode)">
            <select
              value={s.historyBackend ?? ''}
              onChange={(e) => patch({ historyBackend: (e.target.value || undefined) as HistoryBackend | undefined })}
              style={input}
            >
              <option value="">None (local only)</option>
              <option value="blockfrost">Blockfrost</option>
              <option value="koios">Koios</option>
            </select>
          </Label>
          <p style={{ ...hint, marginTop: 0 }}>
            Ogmios + Kupo can&apos;t serve transaction history, token names/images or ADA-Handle
            lookup. Pick a remote indexer to supply those while your local node stays in charge of
            balances, signing and submission. Leave as “None” to stay fully local.
          </p>
        </>
      )}

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '16px 0 4px', cursor: 'pointer' }}>
        <input type="checkbox" checked={s.nftImages !== false} onChange={(e) => patch({ nftImages: e.target.checked })} />
        <span style={{ fontSize: 13, color: '#444' }}>Show NFT images</span>
      </label>
      <p style={{ ...hint, marginTop: 0 }}>
        When on, the wallet fetches NFT art from a public IPFS gateway — that gateway can see your IP and
        which NFTs you hold. Turn off for more privacy; token names still show.
      </p>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" style={primary} disabled={busy} onClick={() => void save()}>
          Save
        </button>
        <button type="button" style={secondary} disabled={busy} onClick={() => void test()}>
          Test connection
        </button>
      </div>

      {status && <p style={{ fontSize: 13, marginTop: 12, color: '#2d3748' }}>{status}</p>}

      <ConnectedSites />
    </section>
  );
}

/** Lists dApp origins the user has connected (the allowlist) and lets them revoke access (review #6). */
function ConnectedSites() {
  const [sites, setSites] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    wallet
      .listConnectedDapps()
      .then(setSites)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : 'Failed to load connected sites'));

  useEffect(() => {
    void load();
  }, []);

  async function revoke(origin: string) {
    setErr(null);
    try {
      await wallet.revokeDapp(origin);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Revoke failed');
    }
  }

  return (
    <div style={{ marginTop: 24, borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Connected sites</h2>
      <p style={{ ...hint, marginTop: 0 }}>
        Sites you have connected can read your addresses, balance and UTxOs (each signature still needs
        your approval). Revoke any you no longer trust.
      </p>
      {err && <p style={{ fontSize: 13, color: '#c53030' }}>{err}</p>}
      {sites === null ? (
        <p style={hint}>Loading…</p>
      ) : sites.length === 0 ? (
        <p style={hint}>No sites connected.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {sites.map((origin) => (
            <li key={origin} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0' }}>
              <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{origin}</code>
              <button type="button" style={{ ...secondary, padding: '4px 10px', color: '#c53030', borderColor: '#feb2b2' }} onClick={() => void revoke(origin)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
