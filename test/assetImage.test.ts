import { describe, it, expect } from 'vitest';
import { resolveImageUrl, isBlockedHost, allowedImageMime, IPFS_GATEWAY } from '../src/core/assetImage';

describe('resolveImageUrl — NFT image URI validation (A2, SSRF guard)', () => {
  it('resolves ipfs:// forms via the gateway', () => {
    const cid = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
    expect(resolveImageUrl(`ipfs://${cid}`)).toBe(IPFS_GATEWAY + cid);
    expect(resolveImageUrl(`ipfs://ipfs/${cid}`)).toBe(IPFS_GATEWAY + cid);
    expect(resolveImageUrl(`ipfs://${cid}/art.png`)).toBe(`${IPFS_GATEWAY}${cid}/art.png`);
  });

  it('passes through a public https URL', () => {
    expect(resolveImageUrl('https://img.example.com/nft/1.png')).toBe('https://img.example.com/nft/1.png');
  });

  it('rejects non-https schemes', () => {
    expect(resolveImageUrl('http://img.example.com/1.png')).toBeNull();
    expect(resolveImageUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(resolveImageUrl('ftp://example.com/1.png')).toBeNull();
    expect(resolveImageUrl('file:///etc/passwd')).toBeNull();
    expect(resolveImageUrl('javascript:alert(1)')).toBeNull();
  });

  it('blocks SSRF targets (localhost / private / link-local / metadata)', () => {
    for (const u of [
      'https://localhost/x.png',
      'https://127.0.0.1/x.png',
      'https://10.0.0.5/x.png',
      'https://192.168.1.10/x.png',
      'https://172.16.0.1/x.png',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x.png',
      'https://router.local/x.png',
    ]) {
      expect(resolveImageUrl(u)).toBeNull();
    }
  });

  it('rejects malformed / empty / oversized / relative input', () => {
    expect(resolveImageUrl('')).toBeNull();
    expect(resolveImageUrl('not a url')).toBeNull();
    expect(resolveImageUrl('art.png')).toBeNull();
    expect(resolveImageUrl('ipfs://')).toBeNull();
    expect(resolveImageUrl('ipfs://..%2f..%2fetc')).toBeNull();
    expect(resolveImageUrl('https://e.com/' + 'a'.repeat(3000))).toBeNull();
  });
});

describe('isBlockedHost', () => {
  it('blocks loopback, private, link-local, IPv6 local', () => {
    for (const h of ['localhost', '127.0.0.1', '127.5.5.5', '10.1.2.3', '192.168.0.1', '172.31.255.255', '169.254.1.1', '::1', 'fc00::1', 'fe80::1', 'foo.local']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it('allows public hosts', () => {
    for (const h of ['ipfs.io', 'img.example.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
});

describe('allowedImageMime', () => {
  it('accepts known image types (ignoring parameters)', () => {
    expect(allowedImageMime('image/png')).toBe('image/png');
    expect(allowedImageMime('image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(allowedImageMime('IMAGE/WEBP')).toBe('image/webp');
    expect(allowedImageMime('image/svg+xml')).toBe('image/svg+xml');
  });
  it('rejects non-image / missing types', () => {
    expect(allowedImageMime('text/html')).toBeNull();
    expect(allowedImageMime('application/json')).toBeNull();
    expect(allowedImageMime(null)).toBeNull();
    expect(allowedImageMime('')).toBeNull();
  });
});
