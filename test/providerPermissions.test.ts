// Runtime host-permission helper: URL → match pattern must strip
// credentials/port/path (match patterns don't carry them), and a user denial must surface as
// `false` so the settings UIs show a visible error instead of silently saving a dead config.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hostMatchPattern, ensureHostPermission } from '../src/shared/providerPermissions';

describe('hostMatchPattern', () => {
  it('maps a plain https URL to a host-wide pattern', () => {
    expect(hostMatchPattern('https://koios.example/api/v1')).toBe('https://koios.example/*');
  });

  it('keeps http (localhost Kupo) and drops the port', () => {
    expect(hostMatchPattern('http://localhost:1442')).toBe('http://localhost/*');
  });

  it('strips credentials, query and hash', () => {
    expect(hostMatchPattern('https://user:secret@host.example:8080/path?token=abc#x')).toBe('https://host.example/*');
  });

  it('trims surrounding whitespace', () => {
    expect(hostMatchPattern('  https://host.example/api  ')).toBe('https://host.example/*');
  });

  it('rejects non-http(s) schemes (ws:// Ogmios needs no host permission)', () => {
    expect(hostMatchPattern('ws://localhost:1337')).toBeNull();
    expect(hostMatchPattern('file:///etc/passwd')).toBeNull();
  });

  it('rejects garbage', () => {
    expect(hostMatchPattern('not a url')).toBeNull();
    expect(hostMatchPattern('')).toBeNull();
  });
});

describe('ensureHostPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubPermissions(contains: boolean, request: boolean) {
    const req = vi.fn(async () => request);
    vi.stubGlobal('chrome', { permissions: { contains: vi.fn(async () => contains), request: req } });
    return req;
  }

  it('is a no-op (true) for blank/undefined URLs', async () => {
    stubPermissions(false, false);
    expect(await ensureHostPermission(undefined)).toBe(true);
    expect(await ensureHostPermission('   ')).toBe(true);
  });

  it('is a no-op (true) for a non-requestable URL (ws://)', async () => {
    const req = stubPermissions(false, false);
    expect(await ensureHostPermission('ws://localhost:1337')).toBe(true);
    expect(req).not.toHaveBeenCalled();
  });

  it('skips the prompt when the permission is already granted', async () => {
    const req = stubPermissions(true, false);
    expect(await ensureHostPermission('https://host.example/api')).toBe(true);
    expect(req).not.toHaveBeenCalled();
  });

  it('returns the user decision from chrome.permissions.request', async () => {
    stubPermissions(false, true);
    expect(await ensureHostPermission('https://host.example/api')).toBe(true);
    stubPermissions(false, false);
    expect(await ensureHostPermission('https://host.example/api')).toBe(false);
  });

  it('returns false when the permissions API throws', async () => {
    vi.stubGlobal('chrome', {
      permissions: {
        contains: vi.fn(async () => {
          throw new Error('boom');
        }),
        request: vi.fn(),
      },
    });
    expect(await ensureHostPermission('https://host.example/api')).toBe(false);
  });
});
