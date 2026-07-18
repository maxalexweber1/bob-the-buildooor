// Send flow (T3.4): enter recipient + amount → REVIEW (decoded human-readable summary) → approve →
// submit → confirmation. The approval step renders what the tx actually does (CLAUDE.md §1.5: never
// approve an opaque blob). Approval references the built tx's id, so the signed tx == the one shown.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import { useWalletData } from './store';
import type { BuiltTx, TxStatus, ResolvedHandle } from '../shared/internal';
import type { AssetBalance } from '../core/balance';
import { cip67LabelName } from '../core/cip67';
import { looksLikeHandle } from '../core/handle';
import { primaryButton } from './App';

/** One native-asset line in the review: stripped/decoded name + CIP-67 class badge + quantity. */
function AssetLine({ a }: { a: AssetBalance }) {
  const name = a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
  const badge = a.cip67Label === undefined ? undefined : cip67LabelName(a.cip67Label);
  return (
    <div style={assetLine}>
      {name}
      {badge ? ` [${badge}]` : ''}: {a.quantity}
    </div>
  );
}

/** Soft cap for the optional CIP-20 memo input (the background enforces the byte limit too). */
const MEMO_MAX_CHARS = 256;

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
  const [memo, setMemo] = useState('');
  const [built, setBuilt] = useState<BuiltTx | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ADA Handle resolution (T8.1): when the recipient is a `$handle`, resolve it to the current holder
  // and show that address for the user to verify. We send to the concrete resolved address the user saw
  // (WYSIWYG) — never the raw handle — so there's no gap between what's approved and where funds go.
  const [resolved, setResolved] = useState<ResolvedHandle | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);

  const trimmed = to.trim();
  const isHandle = looksLikeHandle(trimmed);
  const validAddr = !isHandle && /^addr(_test)?1[0-9a-z]{20,}$/.test(trimmed);
  // The address funds will actually go to: the resolved holder for a handle, else the literal address.
  const recipient = isHandle ? resolved?.address : validAddr ? trimmed : undefined;
  let validAmount = false;
  try {
    validAmount = BigInt(adaToLovelace(amount)) > 0n;
  } catch {
    validAmount = false;
  }
  const canReview = recipient !== undefined && validAmount && !busy && !resolving;

  // Debounced resolve: re-run whenever the handle text settles. No persistent cache — each settled edit
  // hits the provider fresh (handles are transferable NFTs; a stale holder could misdirect funds).
  useEffect(() => {
    if (!isHandle) {
      setResolved(null);
      setResolveErr(null);
      setResolving(false);
      return;
    }
    setResolved(null);
    setResolveErr(null);
    setResolving(true);
    let active = true;
    const timer = setTimeout(() => {
      void wallet
        .resolveHandle(trimmed)
        .then((r) => {
          if (active) setResolved(r);
        })
        .catch((e) => {
          if (active) setResolveErr(msg(e));
        })
        .finally(() => {
          if (active) setResolving(false);
        });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmed, isHandle]);

  async function review() {
    if (!recipient) return;
    setBusy(true);
    setError(null);
    try {
      const note = memo.trim();
      setBuilt(await wallet.buildSend(recipient, adaToLovelace(amount), note.length > 0 ? note : undefined));
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
      // Balance/history/UTxOs just changed — drop the popup's cached views so returning to the
      // dashboard fetches fresh data instead of briefly showing the pre-send balance.
      useWalletData.getState().invalidate();
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
              <AssetLine key={a.unit} a={a} />
            ))}
          </div>
        ))}
        {built.summary.message && built.summary.message.lines.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: '#718096' }}>Message (public, on-chain)</div>
            {built.summary.message.lines.map((line, i) => (
              <code key={i} style={codeBox}>{line}</code>
            ))}
          </div>
        )}
        <div style={rowLine}>
          <span>Network fee</span>
          <span>{formatAda(built.summary.fee)} ₳</span>
        </div>
        {change.map((o, i) => (
          <div key={i}>
            <div style={rowLine}>
              <span>Change (back to you)</span>
              <span>{formatAda(o.value.lovelace)} ₳</span>
            </div>
            {o.value.assets.map((a) => (
              <AssetLine key={a.unit} a={a} />
            ))}
          </div>
        ))}
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
      <label style={lbl}>Recipient address or $handle</label>
      <textarea value={to} onChange={(e) => setTo(e.target.value)} rows={3} spellCheck={false} style={{ ...field, fontFamily: 'monospace', resize: 'vertical' }} />
      <p style={{ fontSize: 11, color: '#a0aec0', margin: '2px 0 6px' }}>
        Enter an address, or an ADA Handle like <code>$alice</code>. Double-check it — clipboard malware
        can swap a pasted address. You'll confirm the full address on the next screen.
      </p>
      {isHandle && (
        <div style={{ margin: '2px 0 6px' }}>
          {resolving && <p style={{ fontSize: 11, color: '#a0aec0', margin: 0 }}>Resolving handle…</p>}
          {resolved && !resolving && (
            <div>
              <div style={{ fontSize: 11, color: '#2f855a' }}>${resolved.handle} → current holder ✓</div>
              <code style={codeBox}>{resolved.address}</code>
            </div>
          )}
          {resolveErr && !resolving && <p style={warn}>{resolveErr}</p>}
        </div>
      )}
      <label style={lbl}>Amount (₳)</label>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.0" style={field} />
      <label style={lbl}>Message (optional)</label>
      <input
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        maxLength={MEMO_MAX_CHARS}
        placeholder="A note attached on-chain (CIP-20)"
        style={field}
      />
      <p style={{ fontSize: 11, color: '#a0aec0', margin: '2px 0 6px' }}>
        Public &amp; permanent — stored on-chain in the transaction, visible to everyone.
      </p>
      {error && <p style={warn}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" style={{ ...primaryButton, flex: 1 }} disabled={!canReview} onClick={() => void review()}>
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
