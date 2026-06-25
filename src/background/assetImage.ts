// Service-worker NFT image proxy (A2). Fetches a CIP-25/68 image in the PRIVILEGED background (not the
// popup) and returns it as a self-contained `data:` URI, so the popup renders it under a tight
// `img-src 'self' data:` CSP and never itself contacts a remote host (less render-time correlation).
//
// The URI is attacker-controlled metadata → strict validation lives in core/assetImage.ts (scheme +
// SSRF host allowlist). Here we add the network-side limits: timeout, no credentials, content-type and
// size caps. Anything off-policy returns null and the UI falls back to the generated avatar.
import { resolveImageUrl, allowedImageMime, MAX_IMAGE_BYTES } from '../core/assetImage';
import { toBase64 } from '../core/crypto/encoding';

const IMAGE_TIMEOUT_MS = 8000; // SW dies on a ~30s fetch; keep well under

export async function fetchAssetImage(uri: string): Promise<string | null> {
  const url = resolveImageUrl(uri);
  if (url === null) return null;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      credentials: 'omit', // never attach cookies to a third-party gateway
      cache: 'force-cache', // NFT images are immutable — let the HTTP cache absorb repeats
    });
    if (!res.ok) return null;
    const mime = allowedImageMime(res.headers.get('content-type'));
    if (mime === null) return null; // only real image/* types become a data: URI
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    return `data:${mime};base64,${toBase64(new Uint8Array(buf))}`;
  } catch {
    return null; // timeout / network / abort → fall back to the avatar
  } finally {
    clearTimeout(timer);
  }
}
