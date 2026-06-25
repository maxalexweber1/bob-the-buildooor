// Shared popup UI helpers + small presentational components. Privileged context. All external strings
// render as React text nodes only (CLAUDE.md §1.8) — never dangerouslySetInnerHTML.
import { useEffect, useState, type CSSProperties } from 'react';
import { wallet } from '../shared/walletClient';
import type { Network } from '../background/provider/IChainProvider';

/** lovelace → ADA string (trims trailing zeros). */
export function formatAda(lovelace: string): string {
  const neg = lovelace.startsWith('-');
  const v = neg ? -BigInt(lovelace) : BigInt(lovelace);
  const ada = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${frac ? `${ada}.${frac}` : ada.toString()}`;
}

/** Signed ADA with an explicit +/− and the ₳ symbol, for history rows. */
export function formatAdaSigned(lovelace: string): string {
  const v = BigInt(lovelace);
  if (v === 0n) return '0 ₳';
  const sign = v < 0n ? '−' : '+';
  return `${sign}${formatAda((v < 0n ? -v : v).toString())} ₳`;
}

/** cardanoscan URL for a tx, network-aware (preview./preprod. subdomains; mainnet = root). */
export function explorerTxUrl(network: Network, txHash: string): string {
  const sub = network === 'mainnet' ? '' : `${network}.`;
  return `https://${sub}cardanoscan.io/transaction/${txHash}`;
}

/** Shorten a hash/address for display: head…tail. */
export function shortId(id: string, n = 8): string {
  return id.length <= 2 * n + 1 ? id : `${id.slice(0, n)}…${id.slice(-n)}`;
}

/** Deterministic colour from a policy id, for token avatars. */
export function assetColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360}deg 52% 45%)`;
}

/** Relative time like "3m ago" / "2d ago"; falls back to a date for older entries. */
export function relativeTime(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!unixSeconds) return '';
  const secs = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Round avatar for a native asset — the NFT art (a `data:` URI the SW produced, A2) when available,
 * else a colour-from-policy-id circle with the name's initial. `image` is only ever a self-contained
 * data: URI here, so it renders under the tight `img-src 'self' data:` CSP.
 */
export function TokenAvatar({
  policyId,
  label,
  image,
  size = 24,
}: {
  policyId: string;
  label: string;
  image?: string | undefined;
  size?: number;
}) {
  const base: CSSProperties = {
    width: size,
    height: size,
    minWidth: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  };
  if (image) {
    return (
      <img aria-hidden src={image} alt="" style={{ ...base, objectFit: 'cover' }} />
    );
  }
  return (
    <span
      aria-hidden
      style={{
        ...base,
        background: assetColor(policyId),
        color: '#fff',
        fontSize: size * 0.45,
        fontWeight: 700,
        textTransform: 'uppercase',
      }}
    >
      {(label[0] ?? '?').replace(/[^\x20-\x7e]/, '?')}
    </span>
  );
}

/** Live provider-connection badge: shows the active provider and whether it's reachable. */
export function ProviderBadge() {
  const [state, setState] = useState<'checking' | 'online' | 'offline'>('checking');
  const [label, setLabel] = useState('provider');
  const [reason, setReason] = useState('');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const s = await wallet.getSettings();
        if (active) setLabel(s.providerKind === 'ogmios' ? `ogmios ${s.ogmiosUrl ?? ''}`.trim() : s.providerKind);
        await wallet.pingProvider();
        if (active) setState('online');
      } catch (e) {
        if (active) {
          setState('offline');
          setReason(e instanceof Error ? e.message : 'unreachable');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const color = state === 'online' ? '#2f855a' : state === 'offline' ? '#c53030' : '#a0aec0';
  const text = state === 'checking' ? `${label}…` : state === 'online' ? `${label} connected` : `${label} offline`;
  return (
    <span title={reason || text} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color, maxWidth: '100%' }}>
      <span style={{ width: 8, height: 8, minWidth: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {state === 'offline' && reason ? `${label}: ${reason}` : text}
      </span>
    </span>
  );
}

export const card: React.CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  padding: 14,
  marginBottom: 12,
};
