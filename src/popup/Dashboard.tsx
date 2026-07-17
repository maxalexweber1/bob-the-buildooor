// Read-only dashboard (T2.5): live balance, native assets, receive address, provider status, network
// switch. All chain/asset strings render as React text nodes only (CLAUDE.md §1.8). Privileged context.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWallet } from './store';
import { wallet } from '../shared/walletClient';
import type { WalletOverview, AssetMetadata, BuiltTx } from '../shared/internal';
import type { AssetBalance } from '../core/balance';
import type { Network } from '../background/provider/IChainProvider';
import { primaryButton } from './App';
import { formatAda, shortId, TokenAvatar, ProviderBadge, card } from './ui';
import { cip67LabelName } from '../core/cip67';

const NETWORKS: Network[] = ['preview', 'preprod', 'mainnet'];

export function Dashboard({ onSend }: { onSend: () => void }) {
  const { lock } = useWallet();
  const [overview, setOverview] = useState<WalletOverview | null>(null);
  const [network, setNetwork] = useState<Network>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Lazily-fetched CIP-25/68 display metadata, keyed by asset unit. `fetched` guards against re-querying.
  const [assetMeta, setAssetMeta] = useState<Record<string, AssetMetadata>>({});
  const fetched = useRef<Set<string>>(new Set());
  // NFT art as `data:` URIs (the SW proxies + validates the fetch — background/assetImage.ts).
  const [assetImg, setAssetImg] = useState<Record<string, string>>({});
  const imgFetched = useRef<Set<string>>(new Set());
  // The asset shown in the detail overlay (name, image, description, ids), or null.
  const [detail, setDetail] = useState<AssetBalance | null>(null);
  // CIP-113 programmable-token send overlay (T9.5, experimental).
  const [progSend, setProgSend] = useState<AssetBalance | null>(null);

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

  // Lazily resolve token display names (CIP-25/68) for the visible assets. Sequential on purpose: the
  // background metadata cache is a storage read-modify-write, so parallel calls would clobber writes.
  useEffect(() => {
    if (!overview) return;
    let cancelled = false;
    void (async () => {
      // Regular assets + CIP-113 programmable tokens (separate bundle, same display-name resolution).
      for (const a of [...overview.balance.assets, ...(overview.programmable?.assets ?? [])]) {
        if (fetched.current.has(a.unit)) continue;
        fetched.current.add(a.unit);
        try {
          const md = await wallet.getAssetMetadata(a.unit);
          if (!cancelled && md?.name) setAssetMeta((m) => ({ ...m, [a.unit]: md }));
        } catch {
          // ignore — fall back to the on-chain asset name
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [overview]);

  // Once an asset's metadata (with an image URI) is in, lazily fetch the art via the SW proxy. Sequential
  // and ref-guarded so we hit each gateway URL at most once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const [unit, md] of Object.entries(assetMeta)) {
        if (md.image === undefined || imgFetched.current.has(unit)) continue;
        imgFetched.current.add(unit);
        try {
          const dataUri = await wallet.getAssetImage(md.image);
          if (!cancelled && dataUri) setAssetImg((m) => ({ ...m, [unit]: dataUri }));
        } catch {
          // ignore — fall back to the generated avatar
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetMeta]);

  async function changeNetwork(n: Network) {
    setLoading(true);
    setError(null);
    try {
      await wallet.updateSettings({ network: n });
      setNetwork(n);
      // Asset metadata is network-specific — drop what we resolved for the previous network.
      fetched.current.clear();
      setAssetMeta({});
      imgFetched.current.clear();
      setAssetImg({});
      setOverview(await wallet.getOverview());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch network');
    } finally {
      setLoading(false);
    }
  }

  async function copyAddress() {
    if (!overview) return;
    try {
      await navigator.clipboard.writeText(overview.receiveAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
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
      <div style={{ marginBottom: 12 }}>
        <ProviderBadge />
      </div>

      {error && <p style={{ color: '#c53030', fontSize: 13 }}>{error}</p>}

      <div style={{ ...card, background: 'linear-gradient(135deg,#2b6cb0,#2c5282)', border: 'none', color: '#fff' }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Total balance</div>
        <div style={{ fontSize: 30, fontWeight: 700, margin: '2px 0' }}>
          {loading && !overview ? '…' : overview ? `${formatAda(overview.balance.lovelace)} ₳` : '—'}
        </div>
      </div>

      {overview && overview.balance.assets.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: '#718096', marginBottom: 6 }}>
            Assets ({overview.balance.assets.length})
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 160, overflowY: 'auto' }}>
            {overview.balance.assets.map((a) => {
              // Prefer the resolved CIP-25/68 display name; fall back to the on-chain (UTF-8) name, then hex.
              const name = assetMeta[a.unit]?.name ?? a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
              const badge = a.cip67Label === undefined ? undefined : cip67LabelName(a.cip67Label);
              return (
                <li
                  key={a.unit}
                  style={{ ...assetRow, cursor: 'pointer' }}
                  onClick={() => setDetail(a)}
                  title="View details"
                >
                  <TokenAvatar policyId={a.policyId} label={name} image={assetImg[a.unit]} />
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                    {badge && <span style={tokenBadge}>{badge}</span>}
                  </span>
                  <span style={{ fontSize: 13, color: '#4a5568' }}>{a.quantity}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {overview?.programmable && overview.programmable.assets.length > 0 && (
        <div style={card}>
          <div style={{ fontSize: 12, color: '#718096', marginBottom: 6 }}>
            Programmable tokens ({overview.programmable.assets.length})
          </div>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, maxHeight: 160, overflowY: 'auto' }}>
            {overview.programmable.assets.map((a) => {
              const name = assetMeta[a.unit]?.name ?? a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
              return (
                <li
                  key={a.unit}
                  style={{ ...assetRow, cursor: 'pointer' }}
                  onClick={() => setDetail(a)}
                  title="View details"
                >
                  <TokenAvatar policyId={a.policyId} label={name} image={assetImg[a.unit]} />
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {name}
                    <span style={tokenBadge}>CIP-113</span>
                  </span>
                  <span style={{ fontSize: 13, color: '#4a5568' }}>{a.quantity}</span>
                  <button
                    type="button"
                    style={progSendBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setProgSend(a);
                    }}
                  >
                    Send
                  </button>
                </li>
              );
            })}
          </ul>
          <p style={{ fontSize: 11, color: '#718096', margin: '6px 0 0' }}>
            Held at the CIP-113 programmable-token contract. Transfers run the issuer’s on-chain
            rules (experimental — testnet configuration required).
          </p>
        </div>
      )}

      {progSend && (
        <ProgrammableSend
          a={progSend}
          onClose={() => setProgSend(null)}
          onDone={() => {
            setProgSend(null);
            void load();
          }}
        />
      )}

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: '#718096' }}>Receive address</span>
          <button type="button" onClick={() => void copyAddress()} style={copyBtn}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
        </div>
        <code style={{ fontSize: 11, wordBreak: 'break-all', color: '#2d3748' }} title={overview?.receiveAddress}>
          {overview ? shortId(overview.receiveAddress, 16) : '…'}
        </code>
      </div>

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

      {detail && (
        <AssetDetail
          a={detail}
          meta={assetMeta[detail.unit]}
          image={assetImg[detail.unit]}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

/**
 * CIP-113 programmable-token send (T9.5, EXPERIMENTAL). Form → decoded review → approve. The review
 * makes the programmable mechanics explicit instead of a generic "script interaction" (§1.5): where
 * the tokens actually land (the recipient's PROGRAMMABLE address, derived from their base address),
 * and that the issuer's on-chain transfer rules run via two withdraw-zero validator invocations.
 * Approval reuses the plain-send machinery — the signed tx is exactly the one summarized (id-bound).
 */
function ProgrammableSend({ a, onClose, onDone }: { a: AssetBalance; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState('');
  const [qty, setQty] = useState('');
  const [built, setBuilt] = useState<BuiltTx | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
  const validQty = /^\d+$/.test(qty.trim()) && BigInt(qty.trim() || '0') > 0n;
  const validTo = /^addr(_test)?1[0-9a-z]{20,}$/.test(to.trim());

  async function review() {
    setBusy(true);
    setError(null);
    try {
      setBuilt(await wallet.buildProgrammableSend(a.unit, to.trim(), qty.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Build failed');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!built) return;
    setBusy(true);
    setError(null);
    try {
      setTxHash((await wallet.approveSend(built.id)).txHash);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submit failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await wallet.cancelSend().catch(() => undefined);
    onClose();
  }

  return (
    <div style={overlay} onClick={() => void cancel()}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
          Send {name}
          <span style={tokenBadge}>CIP-113</span>
        </div>

        {txHash ? (
          <div>
            <p style={{ fontSize: 13, color: '#2f855a' }}>Submitted ✓</p>
            <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{txHash}</code>
            <button type="button" style={{ ...primaryButton, marginTop: 10 }} onClick={onDone}>
              Done
            </button>
          </div>
        ) : built ? (
          <div>
            <p style={{ fontSize: 12, color: '#718096', margin: '0 0 6px' }}>
              Review — the tokens move to the recipient’s programmable address (ownership = their
              stake credential); the issuer’s transfer rules run on-chain via two validator
              invocations. This is an experimental CIP-113 transfer.
            </p>
            <div style={{ fontSize: 12, color: '#718096' }}>Sends</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>
              {built.cip113?.quantity} × {name}
            </div>
            <div style={{ fontSize: 12, color: '#718096', marginTop: 6 }}>To (programmable address)</div>
            <code style={{ fontSize: 11, wordBreak: 'break-all', display: 'block' }}>
              {built.cip113?.toProgrammableAddress}
            </code>
            <div style={{ fontSize: 12, color: '#718096', marginTop: 6 }}>Recipient (base address entered)</div>
            <code style={{ fontSize: 11, wordBreak: 'break-all', display: 'block' }}>{to.trim()}</code>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginTop: 8 }}>
              <span>Network fee</span>
              <span>{formatAda(built.summary.fee)} ₳</span>
            </div>
            {error && <p style={{ color: '#c53030', fontSize: 13 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button type="button" style={{ ...primaryButton, flex: 1 }} disabled={busy} onClick={() => void approve()}>
                {busy ? 'Sending…' : 'Approve & Send'}
              </button>
              <button type="button" style={{ ...primaryButton, flex: 1, background: '#a0aec0' }} disabled={busy} onClick={() => void cancel()}>
                Reject
              </button>
            </div>
          </div>
        ) : (
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#4a5568', margin: '6px 0 2px' }}>
              Recipient base address (addr…) — their stake credential becomes the owner
            </label>
            <textarea
              value={to}
              onChange={(e) => setTo(e.target.value)}
              rows={3}
              spellCheck={false}
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 12, fontFamily: 'monospace' }}
            />
            <label style={{ display: 'block', fontSize: 12, color: '#4a5568', margin: '6px 0 2px' }}>
              Quantity (you hold {a.quantity})
            </label>
            <input
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="numeric"
              style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '6px 8px' }}
            />
            {error && <p style={{ color: '#c53030', fontSize: 13 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                type="button"
                style={{ ...primaryButton, flex: 1 }}
                disabled={!validTo || !validQty || busy}
                onClick={() => void review()}
              >
                {busy ? 'Building…' : 'Review'}
              </button>
              <button type="button" style={{ ...primaryButton, flex: 1, background: '#a0aec0' }} onClick={() => void cancel()}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Detail overlay for one native asset: art, decoded name + class, description, and on-chain ids.
 *  All external strings (name/description) render as React text nodes only (CLAUDE.md §1.8/§8). */
function AssetDetail({
  a,
  meta,
  image,
  onClose,
}: {
  a: AssetBalance;
  meta: AssetMetadata | undefined;
  image: string | undefined;
  onClose: () => void;
}) {
  const name = meta?.name ?? a.assetNameUtf8 ?? `${a.assetNameHex.slice(0, 12)}…`;
  const badge = a.cip67Label === undefined ? undefined : cip67LabelName(a.cip67Label);
  return (
    <div style={overlay} onClick={onClose}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Close" style={closeBtn} onClick={onClose}>
          ×
        </button>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <TokenAvatar policyId={a.policyId} label={name} image={image} size={96} />
        </div>
        <div style={{ fontWeight: 700, fontSize: 16, textAlign: 'center' }}>
          {name}
          {badge && <span style={tokenBadge}>{badge}</span>}
        </div>
        {meta?.description && (
          <p style={{ fontSize: 13, color: '#4a5568', marginTop: 8 }}>{meta.description}</p>
        )}
        <div style={detailRow}>
          <span>Quantity</span>
          <span>{a.quantity}</span>
        </div>
        {meta?.decimals !== undefined && (
          <div style={detailRow}>
            <span>Decimals</span>
            <span>{meta.decimals}</span>
          </div>
        )}
        <div style={detailRow}>
          <span>Policy</span>
          <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.policyId}</code>
        </div>
        <div style={detailRow}>
          <span>Asset name</span>
          <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{a.assetNameHex || '(empty)'}</code>
        </div>
      </div>
    </div>
  );
}

const assetRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 0',
  borderBottom: '1px solid #edf2f7',
};
const copyBtn: React.CSSProperties = {
  fontSize: 11,
  color: '#2b6cb0',
  background: 'transparent',
  border: '1px solid #cbd5e0',
  borderRadius: 5,
  padding: '2px 8px',
  cursor: 'pointer',
};
const progSendBtn: React.CSSProperties = {
  marginLeft: 8,
  fontSize: 11,
  color: '#2b6cb0',
  background: 'transparent',
  border: '1px solid #cbd5e0',
  borderRadius: 5,
  padding: '2px 8px',
  cursor: 'pointer',
};
const tokenBadge: React.CSSProperties = {
  marginLeft: 6,
  fontSize: 10,
  fontWeight: 600,
  color: '#4a5568',
  background: '#edf2f7',
  borderRadius: 4,
  padding: '1px 5px',
  verticalAlign: 'middle',
};
const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  zIndex: 50,
};
const modalCard: React.CSSProperties = {
  position: 'relative',
  background: '#fff',
  borderRadius: 12,
  padding: 18,
  width: '100%',
  maxWidth: 320,
  maxHeight: '90%',
  overflowY: 'auto',
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
};
const closeBtn: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 10,
  border: 'none',
  background: 'transparent',
  fontSize: 22,
  lineHeight: 1,
  color: '#718096',
  cursor: 'pointer',
};
const detailRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 12,
  color: '#4a5568',
  borderTop: '1px solid #edf2f7',
  padding: '6px 0',
  marginTop: 4,
};
