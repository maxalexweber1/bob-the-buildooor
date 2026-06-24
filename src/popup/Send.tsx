// Send flow (T3.4): enter recipient + amount → REVIEW (decoded human-readable summary) → approve →
// submit → confirmation. The approval step renders what the tx actually does (CLAUDE.md §1.5: never
// approve an opaque blob). Approval references the built tx's id, so the signed tx == the one shown.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import type { BuiltTx, TxStatus } from '../shared/internal';
import { primaryButton } from './App';

export function formatAda(lovelace: string): string {
  const v = BigInt(lovelace);
  const ada = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${ada}.${frac}` : ada.toString();
}

/** Parse a decimal ADA string to integer lovelace. Throws on malformed input. */
function adaToLovelace(ada: string): string {
  const t = ada.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error('invalid amount');
  const parts = t.split('.');
  const whole = parts[0] ?? '0';
  const frac = parts[1] ?? '';
  return (BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6))).toString();
}

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function Send({ onBack }: { onBack: () => void }) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [built, setBuilt] = useState<BuiltTx | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validAddr = /^addr(_test)?1[0-9a-z]{20,}$/.test(to.trim());
  let validAmount = false;
  try {
    validAmount = BigInt(adaToLovelace(amount)) > 0n;
  } catch {
    validAmount = false;
  }

  async function review() {
    setBusy(true);
    setError(null);
    try {
      setBuilt(await wallet.buildSend(to.trim(), adaToLovelace(amount)));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!built) return;
    setBusy(true);
    setError(null);
    try {
      setTxHash((await wallet.approveSend(built.id)).txHash);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    await wallet.cancelSend().catch(() => undefined);
    setBuilt(null);
    setError(null);
  }

  // --- Submitted (poll for confirmation) ---
  if (txHash) {
    return <Submitted txHash={txHash} onBack={onBack} />;
  }

  // --- Approval (decoded summary) ---
  if (built) {
    const recipients = built.summary.outputs.filter((o) => !o.isOwn);
    const change = built.summary.outputs.filter((o) => o.isOwn);
    return (
      <div>
        <h2 style={h2}>Review transaction</h2>
        {recipients.map((o, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#718096' }}>To</div>
            <code style={codeBox}>{o.address}</code>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{formatAda(o.value.lovelace)} ₳</div>
            {o.value.assets.map((a) => (
              <div key={a.unit} style={assetLine}>
                {a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`}: {a.quantity}
              </div>
            ))}
          </div>
        ))}
        <div style={rowLine}>
          <span>Network fee</span>
          <span>{formatAda(built.summary.fee)} ₳</span>
        </div>
        {change.length > 0 && (
          <div style={rowLine}>
            <span>Change (back to you)</span>
            <span>{formatAda(change[0]?.value.lovelace ?? '0')} ₳</span>
          </div>
        )}
        {built.summary.unresolvedInputs > 0 && (
          <p style={warn}>⚠ {built.summary.unresolvedInputs} input(s) could not be resolved for display.</p>
        )}
        {error && <p style={warn}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" style={{ ...primaryButton, flex: 1 }} disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Sending…' : 'Approve & Send'}
          </button>
          <button type="button" style={{ ...primaryButton, flex: 1, background: '#a0aec0' }} disabled={busy} onClick={() => void reject()}>
            Reject
          </button>
        </div>
      </div>
    );
  }

  // --- Form ---
  return (
    <div>
      <h2 style={h2}>Send</h2>
      <label style={lbl}>Recipient address</label>
      <textarea value={to} onChange={(e) => setTo(e.target.value)} rows={3} spellCheck={false} style={{ ...field, fontFamily: 'monospace', resize: 'vertical' }} />
      <p style={{ fontSize: 11, color: '#a0aec0', margin: '2px 0 6px' }}>
        Double-check the address — clipboard malware can swap a pasted address. You'll confirm the full
        address on the next screen.
      </p>
      <label style={lbl}>Amount (₳)</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0" style={field} />
      {error && <p style={warn}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" style={{ ...primaryButton, flex: 1 }} disabled={!validAddr || !validAmount || busy} onClick={() => void review()}>
          {busy ? 'Building…' : 'Review'}
        </button>
        <button type="button" style={{ ...primaryButton, flex: 1, background: '#a0aec0' }} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

/** Submitted view: polls tx status until confirmed (T3.4 "confirmation surfaced"). */
function Submitted({ txHash, onBack }: { txHash: string; onBack: () => void }) {
  const [status, setStatus] = useState<TxStatus>('pending');

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const s = await wallet.getTxStatus(txHash);
        if (!active) return;
        setStatus(s);
        if (s === 'pending') timer = setTimeout(() => void poll(), 8000);
      } catch {
        /* keep last status */
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [txHash]);

  const label =
    status === 'confirmed' ? 'Confirmed ✓' : status === 'unknown' ? 'Submitted ✓' : 'Submitted — confirming…';
  return (
    <div>
      <h2 style={h2}>{label}</h2>
      <div style={{ fontSize: 12, color: '#718096' }}>Transaction hash</div>
      <code style={codeBox}>{txHash}</code>
      <button type="button" style={primaryButton} onClick={onBack}>
        Done
      </button>
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 16, margin: '0 0 12px' };
const lbl: React.CSSProperties = { display: 'block', fontSize: 13, color: '#444', margin: '8px 0 4px' };
const field: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  fontSize: 14,
  border: '1px solid #cbd5e0',
  borderRadius: 6,
};
const codeBox: React.CSSProperties = {
  display: 'block',
  wordBreak: 'break-all',
  fontSize: 11,
  background: '#f7fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: 8,
  margin: '4px 0',
};
const rowLine: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: 13,
  color: '#2d3748',
  padding: '4px 0',
};
const assetLine: React.CSSProperties = { fontSize: 12, color: '#4a5568' };
const warn: React.CSSProperties = { color: '#c53030', fontSize: 13, margin: '6px 0' };
