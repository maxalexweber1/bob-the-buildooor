// dApp approval prompt (T4.1/T4.3/T4.5). Opened as a popup WINDOW (#approve) by the background for a
// gated action — connect, signTx (decoded summary), or signData (address + payload). Renders all
// untrusted strings as text nodes only (CLAUDE.md §1.8); decode-before-sign for signTx (§1.5).
// Closing the window counts as a decline.
import { useEffect, useState } from 'react';
import { wallet } from '../shared/walletClient';
import {
  approvalStorageKey,
  type PendingApproval,
  type TxSummary,
  type BulkTxItem,
  type BulkSignApprovalPayload,
} from '../shared/internal';
import { primaryButton } from './App';
import { formatAda } from './Send';
import { cip67LabelName } from '../core/cip67';
import { fromHex } from '../core/crypto/encoding';

export function Connect() {
  const [pending, setPending] = useState<PendingApproval | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Load exactly the request this window was opened for (reqId in the URL hash), never "the latest"
  // pending one — otherwise two overlapping prompts could show/answer each other's request (review #1).
  // A signTx prompt may open BEFORE its summary is decoded (payloadPending — the window appears
  // instantly, the background fills the payload in): watch the record's session-storage key and
  // re-fetch when the background updates it, so the spinner swaps to the summary without polling.
  useEffect(() => {
    const reqId = approvalReqIdFromHash();
    if (!reqId) {
      setPending(null);
      return;
    }
    const key = approvalStorageKey(reqId);
    const load = () => wallet.getPendingApproval(reqId).then(setPending).catch(() => setPending(null));
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      // Only react to this request's record being UPDATED. Its removal means the request was
      // answered/cancelled — the window is closing anyway, don't blank the UI mid-close.
      if (area === 'session' && changes[key]?.newValue !== undefined) void load();
    };
    chrome.storage.onChanged.addListener(onChanged);
    void load(); // subscribe FIRST so an update between fetch and response is never missed
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  async function respond(approved: boolean) {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await wallet.respondApproval(pending.reqId, approved);
    } finally {
      window.close();
    }
  }

  if (pending === undefined) return <main style={pad}>Loading…</main>;
  if (!pending) return <main style={pad}>No pending request.</main>;

  // Decode-before-sign (§1.5): while the background is still decoding the tx, only a spinner is
  // shown and the approve button stays DISABLED — there is nothing reviewable to approve yet.
  // (The background's respondApproval enforces this too; the UI state is not the only gate.)
  const decoding = pending.payloadPending === true;

  return (
    <main style={pad}>
      <h1 style={{ fontSize: 17, margin: '0 0 4px' }}>{title(pending.type)}</h1>
      <code style={originBox}>{pending.origin}</code>

      {pending.type === 'connect' && (
        <p style={hint}>
          This site will be able to see your addresses, balance, and UTxOs, and request signatures — each
          signature still needs your approval.
        </p>
      )}
      {pending.type === 'signTx' &&
        (decoding ? <DecodingSpinner /> : <SignTxBody summary={pending.payload as TxSummary} />)}
      {pending.type === 'signTxs' &&
        (decoding ? <DecodingSpinner /> : <SignTxsBody payload={pending.payload as BulkSignApprovalPayload} />)}
      {pending.type === 'signData' && <SignDataBody payload={pending.payload as { address: string; payloadHex: string }} />}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button
          type="button"
          style={{ ...primaryButton, flex: 1, ...(decoding ? { background: '#a0aec0', cursor: 'default' } : {}) }}
          disabled={busy || decoding}
          onClick={() => void respond(true)}
        >
          {approveLabel(pending.type)}
        </button>
        <button type="button" style={{ ...primaryButton, flex: 1, background: '#a0aec0' }} disabled={busy} onClick={() => void respond(false)}>
          Reject
        </button>
      </div>
    </main>
  );
}

/** Shown while the background resolves inputs / decodes the tx. Static inline <style> only. */
function DecodingSpinner() {
  return (
    <div style={{ textAlign: 'center', padding: '28px 0' }}>
      <style>{'@keyframes bobspin { to { transform: rotate(360deg); } }'}</style>
      <div
        aria-label="Decoding transaction"
        style={{
          width: 28,
          height: 28,
          margin: '0 auto 10px',
          border: '3px solid #e2e8f0',
          borderTopColor: '#2b6cb0',
          borderRadius: '50%',
          animation: 'bobspin 0.8s linear infinite',
        }}
      />
      <p style={hint}>Decoding transaction — resolving inputs on-chain…</p>
      <p style={hint}>You can review and sign once the full summary is shown.</p>
    </div>
  );
}

function SignTxBody({ summary }: { summary: TxSummary }) {
  const recipients = summary.outputs.filter((o) => !o.isOwn);
  // Render EVERY own output, not just the first — and include their assets — so value (esp. tokens)
  // routed back across multiple wallet addresses is never hidden from the user (review #2 / §1.5).
  const change = summary.outputs.filter((o) => o.isOwn);
  return (
    <div>
      <p style={hint}>Review what this transaction does before signing:</p>
      {recipients.map((o, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={lbl}>Sends to</div>
          <code style={smallBox}>{o.address}</code>
          <div style={{ fontWeight: 700 }}>{formatAda(o.value.lovelace)} ₳</div>
          <AssetRows assets={o.value.assets} />
        </div>
      ))}
      <MintRows mint={summary.mint} />
      <WithdrawalRows withdrawals={summary.withdrawals} />
      <CertRows certs={summary.certificates} />
      <GovernanceRows governance={summary.governance} />
      <MessageRows message={summary.message} />
      <div style={row}><span>Network fee</span><span>{formatAda(summary.fee)} ₳</span></div>
      {change.map((o, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          <div style={row}><span>Change (back to you)</span><span>{formatAda(o.value.lovelace)} ₳</span></div>
          <AssetRows assets={o.value.assets} />
        </div>
      ))}
      {summary.unresolvedInputs > 0 && (
        <p style={{ ...hint, color: '#c05621' }}>⚠ {summary.unresolvedInputs} input(s) could not be resolved for display.</p>
      )}
      <CollateralRows summary={summary} />
      <ReferenceInputRows refs={summary.referenceInputs} />
      <NodeEvalRows nodeEval={summary.nodeEval} />
      <TxFlagsWarning flags={summary.flags} />
    </div>
  );
}

/**
 * CIP-103 bulk signing (T6.5): ONE approval for N transactions. Every tx is rendered in full with the
 * same decoder as a single signTx — a batch is never blind-signed (CLAUDE.md §1.5), and the header
 * states plainly that approving signs all of them. Chaining and same-input conflicts are labelled per
 * transaction so "one approval" never hides what the batch actually does.
 */
function SignTxsBody({ payload }: { payload: BulkSignApprovalPayload }) {
  const items = payload?.items ?? [];
  const totalFee = items.reduce((sum, it) => sum + BigInt(it.summary.fee), 0n).toString();
  return (
    <div>
      <p style={{ ...hint, color: '#9b2c2c', background: '#fff5f5', border: '1px solid #feb2b2', borderRadius: 6, padding: 8 }}>
        ⚠ This site asks you to sign <b>{items.length} transactions</b> at once. Approving signs{' '}
        <b>every one of them</b>. Scroll through and review each before you decide.
      </p>
      <div style={row}>
        <span>Total network fees</span>
        <span style={{ fontWeight: 700 }}>{formatAda(totalFee)} ₳</span>
      </div>
      <div style={{ maxHeight: 340, overflowY: 'auto', marginTop: 6 }}>
        {items.map((it, i) => (
          <BulkTxCard key={i} item={it} index={i} total={items.length} />
        ))}
      </div>
    </div>
  );
}

function BulkTxCard({ item, index, total }: { item: BulkTxItem; index: number; total: number }) {
  const humanList = (idx: number[]) => idx.map((n) => `#${n + 1}`).join(', ');
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: 8, marginBottom: 8 }}>
      <div style={{ ...lbl, marginTop: 0, fontWeight: 700, color: '#2d3748' }}>
        Transaction {index + 1} of {total}
        {item.partialSign ? ' — partial signature' : ''}
      </div>
      {item.dependsOn.length > 0 && (
        <div style={{ ...hint, color: '#2a4365' }}>
          🔗 Chained: spends output(s) of transaction {humanList(item.dependsOn)} in this batch — it can
          only settle after those do.
        </div>
      )}
      {item.conflictsWith.length > 0 && (
        <div style={{ ...hint, color: '#7b341e' }}>
          ⚠ Spends the same input(s) as transaction {humanList(item.conflictsWith)} — only one of them
          can ever settle on-chain.
        </div>
      )}
      <SignTxBody summary={item.summary} />
    </div>
  );
}

/**
 * Collateral at risk — forfeited if the tx's Plutus scripts fail phase-2 validation on-chain. Never
 * approvable invisibly (CLAUDE.md §1.5): every collateral input is shown
 * with its value and whether it is the user's own money.
 */
function CollateralRows({ summary }: { summary: TxSummary }) {
  const { collateralInputs, unresolvedCollateralInputs, collateralReturn, totalCollateral } = summary;
  if (collateralInputs.length === 0 && unresolvedCollateralInputs === 0 && totalCollateral === undefined) {
    return null;
  }
  return (
    <div style={{ marginTop: 8, background: '#fffaf0', border: '1px solid #f6ad55', borderRadius: 6, padding: 8 }}>
      <div style={{ ...lbl, color: '#7b341e' }}>⚠ Collateral — at risk if script validation fails</div>
      {collateralInputs.map((c, i) => (
        <div key={i}>
          <code style={smallBox}>{c.address}</code>
          <div style={row}>
            <span>{c.isOwn ? 'Your funds' : 'Not your funds'}</span>
            <span style={{ fontWeight: 700 }}>{formatAda(c.value.lovelace)} ₳</span>
          </div>
        </div>
      ))}
      {unresolvedCollateralInputs > 0 && (
        <p style={{ ...hint, color: '#c05621' }}>
          ⚠ {unresolvedCollateralInputs} collateral input(s) could not be resolved — the value at risk is unknown.
        </p>
      )}
      {totalCollateral !== undefined && (
        <div style={row}><span>Maximum forfeited on failure</span><span style={{ fontWeight: 700 }}>{formatAda(totalCollateral)} ₳</span></div>
      )}
      {collateralReturn && (
        <div style={row}>
          <span>Returned on failure ({collateralReturn.isOwn ? 'to you' : 'NOT to you'})</span>
          <span>{formatAda(collateralReturn.value.lovelace)} ₳</span>
        </div>
      )}
    </div>
  );
}

/** Reference inputs (CIP-31) are read-only — the tx reads them but does NOT spend them. */
function ReferenceInputRows({ refs }: { refs: TxSummary['referenceInputs'] }) {
  if (refs.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>References {refs.length} input(s) (read-only, not spent)</div>
      {refs.map((r) => (
        <code key={r} style={smallBox}>{r}</code>
      ))}
    </div>
  );
}

/**
 * Plutus cross-check: when the tx carries scripts, we re-run them on the user's OWN node (Ogmios) and
 * show the authoritative ex-units — "verify against your node, not the dApp's claim". `unavailable`
 * (no node / inputs unresolvable) is a neutral nudge, not a block — the tx is still signable.
 */
function NodeEvalRows({ nodeEval }: { nodeEval: TxSummary['nodeEval'] }) {
  if (!nodeEval) return null;
  if (nodeEval.status === 'unavailable') {
    return (
      <div style={{ ...hint, color: '#744210', background: '#fffaf0', border: '1px solid #f6e05e', borderRadius: 6, padding: 8, marginTop: 8 }}>
        🧪 This transaction runs Plutus scripts, not verified on your node. {nodeEval.message}
      </div>
    );
  }
  return (
    <div style={{ marginTop: 8, background: '#f0fff4', border: '1px solid #9ae6b4', borderRadius: 6, padding: 8 }}>
      <div style={{ ...lbl, color: '#22543d' }}>✓ Verified on your node — script execution units</div>
      {nodeEval.redeemers.map((r, i) => (
        <div key={i} style={row}>
          <span>
            {r.purpose} #{r.index}
          </span>
          <span>
            {r.memory.toLocaleString()} mem / {r.cpu.toLocaleString()} cpu
          </span>
        </div>
      ))}
    </div>
  );
}

/** Render an output's native-asset lines (token name best-effort, else truncated hex). */
function AssetRows({ assets }: { assets: TxSummary['outputs'][number]['value']['assets'] }) {
  return (
    <>
      {assets.map((a) => {
        const badge = a.cip67Label === undefined ? undefined : cip67LabelName(a.cip67Label);
        return (
          <div key={a.unit} style={asset}>
            {(a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`)}
            {badge ? ` [${badge}]` : ''}: {a.quantity}
          </div>
        );
      })}
    </>
  );
}

/** Decoded mint/burn — a negative quantity is a burn (review #2: don't blind-sign a mint). */
function MintRows({ mint }: { mint: TxSummary['mint'] }) {
  if (mint.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Mints / burns tokens</div>
      {mint.map((a) => {
        const burn = a.quantity.startsWith('-');
        const name = a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
        return (
          <div key={a.unit} style={{ ...asset, color: burn ? '#9b2c2c' : '#2f855a' }}>
            {burn ? 'Burn' : 'Mint'} {name}: {a.quantity} <span style={{ color: '#a0aec0' }}>({a.policyId.slice(0, 12)}…)</span>
          </div>
        );
      })}
    </div>
  );
}

/** Decoded reward withdrawals — surface destination + amount, not a boolean (review #2). */
function WithdrawalRows({ withdrawals }: { withdrawals: TxSummary['withdrawals'] }) {
  if (withdrawals.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Withdraws staking rewards</div>
      {withdrawals.map((w) => (
        <div key={w.rewardAddress}>
          <code style={smallBox}>{w.rewardAddress}</code>
          <div style={{ fontWeight: 700 }}>{formatAda(w.amount)} ₳</div>
        </div>
      ))}
    </div>
  );
}

/** Decoded certificates (stake + Conway/CIP-95 governance) — so a gov tx is never blind-signed. */
function CertRows({ certs }: { certs: TxSummary['certificates'] }) {
  if (certs.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Certificates</div>
      {certs.map((c, i) => (
        <div key={i} style={asset}>
          {c.description}
        </div>
      ))}
    </div>
  );
}

/** Governance presence: voting procedures (flag) + proposal count (CIP-1694). */
function GovernanceRows({ governance }: { governance: TxSummary['governance'] }) {
  if (!governance.hasVotes && governance.proposals === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Governance</div>
      {governance.hasVotes && <div style={asset}>Casts governance vote(s)</div>}
      {governance.proposals > 0 && <div style={asset}>Submits {governance.proposals} governance proposal(s)</div>}
    </div>
  );
}

/**
 * Decoded CIP-20 message/memo (label 674). Rendered as React text nodes only — never
 * dangerouslySetInnerHTML — since the content is attacker-controlled (CLAUDE.md §8). CIP-83 encrypted
 * bodies are labelled, not shown as if they were readable plaintext.
 */
function MessageRows({ message }: { message: TxSummary['message'] }) {
  if (!message) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={lbl}>Message{message.encrypted ? ' (encrypted — not decoded)' : ''}</div>
      {message.encrypted && message.lines.length === 0 ? (
        <div style={asset}>🔒 This message is encrypted; its contents cannot be shown.</div>
      ) : (
        message.lines.map((line, i) => (
          <div key={i} style={smallBox}>
            {message.encrypted ? '🔒 ' : ''}
            {line}
          </div>
        ))
      )}
    </div>
  );
}

/** Surfaces tx components this build doesn't fully decode yet — so the user is never blind to them. */
function TxFlagsWarning({ flags }: { flags: TxSummary['flags'] }) {
  const present = [
    flags.metadata && 'metadata',
    flags.requiredSigners && 'extra required signer(s)',
  ].filter(Boolean);
  if (present.length === 0) return null;
  return (
    <p style={{ ...hint, color: '#9b2c2c', background: '#fff5f5', border: '1px solid #feb2b2', borderRadius: 6, padding: 8, marginTop: 8 }}>
      ⚠ This transaction also contains: <b>{present.join(', ')}</b>. These are not yet decoded in detail
      — only approve if you fully trust this site.</p>
  );
}

function SignDataBody({ payload }: { payload: { address: string; payloadHex: string; signerKind?: 'payment' | 'stake' | 'drep' } }) {
  const text = decodeHexText(payload.payloadHex);
  const governance = payload.signerKind === 'drep' || payload.signerKind === 'stake';
  return (
    <div>
      {governance && (
        <p style={{ ...hint, color: '#553c9a', background: '#faf5ff', border: '1px solid #d6bcfa', borderRadius: 6, padding: 8 }}>
          🗳 <b>Governance signing (CIP-95).</b> This signs with your{' '}
          {payload.signerKind === 'drep' ? 'DRep key' : 'stake key'} — not a payment address. Governance
          dApps request this for DRep registration, updates or vote authorization. Only approve if you
          initiated a governance action on this site.
        </p>
      )}
      <p style={hint}>This site asks you to sign a message with your key:</p>
      <div style={lbl}>{payload.signerKind === 'drep' ? 'DRep ID' : 'Signing address'}</div>
      <code style={smallBox}>{payload.address}</code>
      <div style={lbl}>Message</div>
      <code style={smallBox}>{text ?? `0x${payload.payloadHex}`}</code>
    </div>
  );
}

function title(t: PendingApproval['type']): string {
  if (t === 'connect') return 'Connection request';
  if (t === 'signTx') return 'Signature request';
  if (t === 'signTxs') return 'Bulk signature request';
  return 'Sign message';
}
function approveLabel(t: PendingApproval['type']): string {
  if (t === 'connect') return 'Connect';
  if (t === 'signTxs') return 'Sign all';
  return 'Sign';
}

/** Extract the reqId from the approval window's URL hash, e.g. "#approve?req=<uuid>". */
function approvalReqIdFromHash(): string {
  const query = window.location.hash.split('?')[1] ?? '';
  return new URLSearchParams(query).get('req') ?? '';
}

/** Decode hex → UTF-8 only if printable; otherwise show hex. Uses the STRICT fromHex so the popup
 *  never renders a "decoded" text that differs from the bytes the wallet will sign. */
function decodeHexText(hex: string): string | null {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(fromHex(hex));
    return /^[\x20-\x7e\s]+$/.test(s) && s.length > 0 ? s : null;
  } catch {
    return null;
  }
}

const pad: React.CSSProperties = { padding: 16 };
const hint: React.CSSProperties = { fontSize: 12, color: '#718096', lineHeight: 1.5 };
const lbl: React.CSSProperties = { fontSize: 12, color: '#718096', marginTop: 8 };
const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' };
const asset: React.CSSProperties = { fontSize: 12, color: '#4a5568' };
const originBox: React.CSSProperties = {
  display: 'block',
  wordBreak: 'break-all',
  fontSize: 13,
  background: '#edf2f7',
  borderRadius: 6,
  padding: 6,
  margin: '6px 0',
};
const smallBox: React.CSSProperties = {
  display: 'block',
  wordBreak: 'break-all',
  fontSize: 11,
  background: '#f7fafc',
  border: '1px solid #e2e8f0',
  borderRadius: 6,
  padding: 6,
  margin: '2px 0',
};
