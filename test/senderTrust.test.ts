import { describe, it, expect } from 'vitest';
import { isTrustedExtensionSender } from '../src/background/senderTrust';
import { isInternalRequest, INTERNAL_TARGET } from '../src/shared/internal';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT = `chrome-extension://${ID}`;

describe('isTrustedExtensionSender (security boundary)', () => {
  it('accepts the popup of THIS extension (own origin)', () => {
    expect(isTrustedExtensionSender({ id: ID, url: `${EXT}/src/popup/index.html` }, ID)).toBe(true);
  });

  it('accepts the options page even though it opens IN A TAB (trusted by URL, not tab-absence)', () => {
    // open_in_tab options page → sender carries a tab but a chrome-extension:// URL → trusted.
    expect(isTrustedExtensionSender({ id: ID, url: `${EXT}/src/options/index.html` }, ID)).toBe(true);
  });

  it('REJECTS a content script (web URL) even from our own extension', () => {
    expect(isTrustedExtensionSender({ id: ID, url: 'https://dapp.example' }, ID)).toBe(false);
  });

  it('REJECTS a different extension id', () => {
    expect(isTrustedExtensionSender({ id: 'other', url: `chrome-extension://other/x.html` }, ID)).toBe(
      false,
    );
  });

  it('REJECTS a web origin URL', () => {
    expect(isTrustedExtensionSender({ id: ID, url: 'https://evil.example/x' }, ID)).toBe(false);
  });

  it('REJECTS when url is missing', () => {
    expect(isTrustedExtensionSender({ id: ID }, ID)).toBe(false);
  });
});

describe('isInternalRequest', () => {
  it('matches only the namespaced internal envelope', () => {
    expect(isInternalRequest({ target: INTERNAL_TARGET, command: { type: 'getStatus' } })).toBe(true);
    expect(isInternalRequest({ target: 'bob:content', method: 'enable' })).toBe(false);
    expect(isInternalRequest(null)).toBe(false);
    expect(isInternalRequest('getStatus')).toBe(false);
  });
});
