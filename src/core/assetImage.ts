// Pure validation for NFT image URIs (A2). The image URI comes from CIP-25/68 on-chain metadata, i.e.
// it is ATTACKER-CONTROLLED (an NFT creator picks it). Before the service worker fetches it we must:
//   - allow only ipfs:// (resolved via a gateway) and https:// — never http/data/blob/file,
//   - block localhost / private / link-local / cloud-metadata hosts (SSRF: the SW must not be turned
//     into a probe of the user's own network),
// and the caller additionally enforces size / content-type / timeout limits. Framework-free, no fetch,
// no chrome.* — so the security-critical parsing is unit-testable in isolation.

/** Default IPFS gateway. Public; the SW (not the popup) contacts it — see background/assetImage.ts. */
export const IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

/** Hard cap on a fetched image (bytes). NFT art is small; this bounds memory + the data-URI size. */
export const MAX_IMAGE_BYTES = 1_000_000;

/** Image MIME types we will turn into a data: URI. SVG is allowed: as an <img> src it can't run script. */
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif']);

/** True for hosts the SW must never fetch (SSRF guard). Conservative string/range checks, no DNS. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === '' || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (h === '169.254.169.254') return true; // cloud metadata endpoint
  // IPv4 loopback / private / link-local ranges
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

/**
 * Resolve a metadata image URI to a concrete https URL the SW may fetch, or null if it is not allowed.
 * `ipfs://CID/path` and `ipfs://ipfs/CID` → `${gateway}CID/path`; `https://…` passes through unless the
 * host is blocked. Everything else (http, data, ftp, relative, malformed) → null.
 */
export function resolveImageUrl(uri: string, gateway: string = IPFS_GATEWAY): string | null {
  if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2048) return null;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([^\s?#][^\s]*)$/i.exec(uri.trim());
  if (ipfs) {
    const path = ipfs[1];
    return path && /^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(path) ? gateway + path : null;
  }
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;
  return u.href;
}

/** Normalize a response content-type to an allowed image MIME, or null. */
export function allowedImageMime(contentType: string | null): string | null {
  if (!contentType) return null;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_MIME.has(mime) ? mime : null;
}
