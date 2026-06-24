// Security review #1: concurrent dApp approval prompts must stay isolated. A malicious dApp firing a
// signTx right after a legitimate connect must NOT be able to displace the legitimate request, and a
// popup window must only ever read/answer the exact request it was opened for. These tests pin the
// per-reqId keying that guarantees that.
import { describe, it, expect } from 'vitest';
import {
  requestApproval,
  getPendingApproval,
  respondApproval,
  onApprovalWindowClosed,
} from '../src/background/dapp/approvals';

interface CreatedWindow {
  url: string;
  id: number;
}

/** Install a minimal in-memory chrome mock (storage.session + windows.create + runtime.getURL). */
function setupChromeMock(): { created: CreatedWindow[] } {
  const session = new Map<string, unknown>();
  const created: CreatedWindow[] = [];
  let nextWindowId = 100;
  const mock = {
    storage: {
      session: {
        get: (key: string) =>
          Promise.resolve(session.has(key) ? { [key]: session.get(key) } : {}),
        set: (obj: Record<string, unknown>) => {
          Object.entries(obj).forEach(([k, v]) => session.set(k, v));
          return Promise.resolve();
        },
        remove: (key: string) => {
          session.delete(key);
          return Promise.resolve();
        },
      },
    },
    windows: {
      create: (opts: { url: string }) => {
        const id = ++nextWindowId;
        created.push({ url: opts.url, id });
        return Promise.resolve({ id });
      },
    },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  };
  globalThis.chrome = mock as unknown as typeof chrome;
  return { created };
}

/** Extract the reqId the background put in the popup window's URL hash. */
function reqIdOf(url: string): string {
  return new URLSearchParams(url.split('?')[1] ?? '').get('req') ?? '';
}

/** Let the concurrent requestApproval() calls finish creating their windows + storing records. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('dApp approvals — concurrent isolation (review #1)', () => {
  it('two overlapping prompts get distinct reqIds and distinct stored records', async () => {
    const { created } = setupChromeMock();
    const pGood = requestApproval('connect', 'https://good.example');
    const pEvil = requestApproval('signTx', 'https://evil.example', { tx: 'deadbeef' });
    await flush();

    expect(created).toHaveLength(2);
    const ids = created.map((c) => reqIdOf(c.url));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]); // no shared key → no overwrite

    const recs = await Promise.all(ids.map((id) => getPendingApproval(id)));
    const origins = recs.map((r) => r?.origin).sort();
    expect(origins).toEqual(['https://evil.example', 'https://good.example']);

    // clean up the open waiters
    await Promise.all(ids.map((id) => respondApproval(id, false)));
    await Promise.all([pGood, pEvil]);
  });

  it('responding to one request does not drop or answer the other', async () => {
    const { created } = setupChromeMock();
    const pGood = requestApproval('connect', 'https://good.example');
    const pEvil = requestApproval('signTx', 'https://evil.example');
    await flush();

    const byOrigin = new Map<string, string>();
    for (const c of created) {
      const id = reqIdOf(c.url);
      const rec = await getPendingApproval(id);
      if (rec) byOrigin.set(rec.origin, id);
    }
    const goodId = byOrigin.get('https://good.example') ?? '';
    const evilId = byOrigin.get('https://evil.example') ?? '';
    expect(goodId).toBeTruthy();
    expect(evilId).toBeTruthy();

    await respondApproval(evilId, true);

    // evil's record is cleared; the legitimate request is untouched and still pending
    expect(await getPendingApproval(evilId)).toBeNull();
    expect(await getPendingApproval(goodId)).not.toBeNull();
    await expect(pEvil).resolves.toBe(true);

    await respondApproval(goodId, false);
    await expect(pGood).resolves.toBe(false);
  });

  it('a closed window declines only its own request', async () => {
    const { created } = setupChromeMock();
    const pA = requestApproval('connect', 'https://a.example');
    const pB = requestApproval('connect', 'https://b.example');
    await flush();

    // find the window opened for b.example and close it
    let bWindowId = -1;
    let aReqId = '';
    for (const c of created) {
      const id = reqIdOf(c.url);
      const rec = await getPendingApproval(id);
      if (rec?.origin === 'https://b.example') bWindowId = c.id;
      if (rec?.origin === 'https://a.example') aReqId = id;
    }
    onApprovalWindowClosed(bWindowId);
    await expect(pB).resolves.toBe(false);

    // a.example is still live and resolves independently
    await respondApproval(aReqId, true);
    await expect(pA).resolves.toBe(true);
  });

  it('getPendingApproval returns null for an empty or unknown reqId', async () => {
    setupChromeMock();
    expect(await getPendingApproval('')).toBeNull();
    expect(await getPendingApproval('no-such-req')).toBeNull();
  });
});
