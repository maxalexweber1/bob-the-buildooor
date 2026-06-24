// Security review #3: the empty/opaque origin must never reach the allowlist or a signing prompt.
import { describe, it, expect } from 'vitest';
import { isValidDappOrigin } from '../src/background/cip30/handlers';

describe('isValidDappOrigin (review #3)', () => {
  it('accepts https web origins', () => {
    expect(isValidDappOrigin('https://app.example')).toBe(true);
    expect(isValidDappOrigin('https://sub.dapp.io')).toBe(true);
  });

  it('accepts http only for localhost (dev)', () => {
    expect(isValidDappOrigin('http://localhost:3000')).toBe(true);
    expect(isValidDappOrigin('http://127.0.0.1:8080')).toBe(true);
  });

  it('rejects empty / opaque / non-web origins', () => {
    for (const bad of ['', 'null', 'http://evil.example', 'file://', 'data:text/html,x', 'chrome-extension://abc', 'ftp://x', 'app.example']) {
      expect(isValidDappOrigin(bad)).toBe(false);
    }
  });
});
