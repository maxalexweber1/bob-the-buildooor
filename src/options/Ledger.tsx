// Hardware-wallet manager (EXECUTION_PLAN T6.3 Ledger / T6.4 Trezor). Lives in the options page — a
// full tab — because Ledger's WebHID needs a user-gesture device chooser in a page context (the MV3
// SW can't call it, and the action popup dies when the native chooser steals focus). Trezor is the
// mirror image: its SDK runs in the SW and opens the Trezor-hosted popup, so those commands just go
// over the wallet client. Shared flow: pair → import the account xpub (watch-only, no keys in the
// browser) → balance/receive → send with the decoded summary shown FIRST (CLAUDE.md §1.5), then the
// device as the final signer + physical consent gate. Chain/device strings are text nodes only (§1.8).
import { useCallback, useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { HwAccountView, HwBuiltTx, WalletOverview } from '../shared/internal';
import { withLedger, readAccountXpub, signOnLedger } from './ledgerDevice';
import { formatAda } from '../popup/ui';

/** ADA text input → lovelace string. Decimal-string math — no floats near money. */
function adaToLovelace(ada: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(ada.trim());
  if (!m || m[1] === undefined) return null;
  const frac = (m[2] ?? '').padEnd(6, '0');
  return (BigInt(m[1]) * 1_000_000n + BigInt(frac)).toString();
}

export function Ledger() {
  const [accounts, setAccounts] = useState<HwAccountView[] | null>(null);
  const [selected, setSelected] = useState<HwAccountView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await wallet.hwListAccounts());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Failed to load hardware accounts');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function connectLedger() {
    setBusy(true);
    setStatus('Connect your Ledger, unlock it and open the Cardano app…');
    try {
      const xpub = await withLedger((app) => readAccountXpub(app, 0));
      const account = await wallet.hwImportAccount('ledger', xpub, 'Ledger');
      setStatus('Device paired ✓');
      await refresh();
      setSelected(account);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  }

  async function connectTrezor() {
    setBusy(true);
    setStatus('A Trezor Connect window will open — approve the export of the account public key…');
    try {
      const account = await wallet.hwTrezorPair();
      setStatus('Device paired ✓');
      await refresh();
      setSelected(account);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  }

  async function forget(id: string) {
    await wallet.hwForgetAccount(id);
    if (selected?.id === id) setSelected(null);
    await refresh();
  }

  return (
    <section style={card}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>Hardware wallets</h2>
      <p style={hint}>
        Watch-only pairing: the wallet stores the account public key; private keys never leave the
        device, and every transaction is confirmed on its screen.
      </p>

      {status && <p style={{ ...hint, color: '#2b6cb0' }}>{status}</p>}

      {accounts === null ? (
        <p style={hint}>Loading…</p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0' }}>
            {accounts.map((a) => (
              <li key={a.id} style={accountRow}>
                <button type="button" style={{ ...secondary, flex: 1, textAlign: 'left' }} onClick={() => setSelected(a)}>
                  {a.label} {selected?.id === a.id ? '◂' : ''}
                </button>
                <button type="button" style={dangerLink} onClick={() => void forget(a.id)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
          <button type="button" style={primary} disabled={busy} onClick={() => void connectLedger()}>
            Connect Ledger
          </button>{' '}
          <button type="button" style={primary} disabled={busy} onClick={() => void connectTrezor()}>
            Connect Trezor
          </button>
        </>
      )}

      {selected && <LedgerAccount key={selected.id} account={selected} />}
    </section>
  );
}

function LedgerAccount({ account }: { account: HwAccountView }) {
  const [overview, setOverview] = useState<WalletOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(await wallet.hwOverview(account.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load account');
    }
  }, [account.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ marginTop: 16, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>{account.label}</h3>
      {error && <p style={{ ...hint, color: '#c53030' }}>{error}</p>}
      {!overview ? (
        <p style={hint}>Loading balance…</p>
      ) : (
        <>
          <p style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>{formatAda(overview.balance.lovelace)} ₳</p>
          {overview.balance.assets.length > 0 && (
            <p style={hint}>+ {overview.balance.assets.length} native asset(s)</p>
          )}
          <p style={hint}>
            Receive address (network: {overview.network}):
            <br />
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{overview.receiveAddress}</code>
          </p>
          <button type="button" style={secondary} onClick={() => void load()}>
            Refresh
          </button>{' '}
          <button type="button" style={primary} onClick={() => setSending(true)}>
            Send
          </button>
          {sending && <HwSend account={account} onDone={() => void load()} onClose={() => setSending(false)} />}
        </>
      )}
    </div>
  );
}

function HwSend({ account, onDone, onClose }: { account: HwAccountView; onDone: () => void; onClose: () => void }) {
  const accountId = account.id;
  const [to, setTo] = useState('');
  const [ada, setAda] = useState('');
  const [built, setBuilt] = useState<HwBuiltTx | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function build() {
    const lovelace = adaToLovelace(ada);
    if (lovelace === null) {
      setStatus('Enter a valid amount (up to 6 decimals).');
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      setBuilt(await wallet.hwBuildSend(accountId, to.trim(), lovelace));
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await wallet.hwCancelSend().catch(() => undefined);
    setBuilt(null);
    onClose();
  }

  async function signAndSubmit() {
    if (!built) return;
    setBusy(true);
    setStatus('Review and confirm the transaction on your device…');
    try {
      let res;
      if (account.kind === 'trezor') {
        // Trezor: the SW drives the Trezor Connect popup, verifies the witnesses, and submits.
        res = await wallet.hwTrezorSign(built.id);
      } else {
        // Ledger: this page drives the device over WebHID; the SW verifies + submits.
        const { deviceTxHashHex, witnesses } = await withLedger((app) => signOnLedger(app, built.ledgerTx));
        setStatus('Submitting…');
        res = await wallet.hwSubmitSigned(built.id, deviceTxHashHex, witnesses);
      }
      setTxHash(res.txHash);
      setStatus(null);
      onDone();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Signing failed');
    } finally {
      setBusy(false);
    }
  }

  if (txHash) {
    return (
      <div style={panel}>
        <p style={hint}>Submitted ✓</p>
        <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{txHash}</code>
        <div style={{ marginTop: 8 }}>
          <button type="button" style={secondary} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  // Review step (§1.5): the decoded outputs/fee are shown BEFORE the device is ever invoked; the
  // device screen is the second, physical check of the same values.
  if (built) {
    return (
      <div style={panel}>
        <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>Review transaction</h4>
        {built.summary.outputs.map((o, i) => (
          <p key={i} style={{ ...hint, margin: '4px 0' }}>
            {o.isOwn ? 'Change (back to this account)' : 'To'}:{' '}
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{o.address}</code>
            <br />
            <b>{formatAda(o.value.lovelace)} ₳</b>
            {o.value.assets.length > 0 ? ` + ${o.value.assets.length} asset(s)` : ''}
          </p>
        ))}
        <p style={hint}>Fee: {formatAda(built.summary.fee)} ₳</p>
        {status && <p style={{ ...hint, color: '#2b6cb0' }}>{status}</p>}
        <button type="button" style={primary} disabled={busy} onClick={() => void signAndSubmit()}>
          Sign on device
        </button>{' '}
        <button type="button" style={secondary} disabled={busy} onClick={() => void cancel()}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={panel}>
      <h4 style={{ fontSize: 13, margin: '0 0 6px' }}>Send from {account.label}</h4>
      <input
        style={input}
        placeholder="Recipient address (addr…)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input style={input} placeholder="Amount in ADA" value={ada} onChange={(e) => setAda(e.target.value)} />
      {status && <p style={{ ...hint, color: '#c53030' }}>{status}</p>}
      <button type="button" style={primary} disabled={busy || !to || !ada} onClick={() => void build()}>
        {busy ? 'Building…' : 'Continue'}
      </button>{' '}
      <button type="button" style={secondary} disabled={busy} onClick={() => void cancel()}>
        Cancel
      </button>
    </div>
  );
}

const card: React.CSSProperties = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 20, marginTop: 16 };
const hint: React.CSSProperties = { fontSize: 13, color: '#4a5568' };
const panel: React.CSSProperties = { marginTop: 12, background: '#f7fafc', borderRadius: 8, padding: 12 };
const input: React.CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 13,
  padding: '7px 9px',
  margin: '6px 0',
  border: '1px solid #cbd5e0',
  borderRadius: 6,
};
const primary: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  background: '#2b6cb0',
  border: 'none',
  borderRadius: 6,
  padding: '8px 14px',
  cursor: 'pointer',
};
const secondary: React.CSSProperties = { ...primary, color: '#2b6cb0', background: 'transparent', border: '1px solid #cbd5e0' };
const dangerLink: React.CSSProperties = {
  fontSize: 12,
  color: '#c53030',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};
const accountRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' };
