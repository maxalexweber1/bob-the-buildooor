// Security review #1: concurrent dApp approval prompts must stay isolated. A malicious dApp firing a
// signTx right after a legitimate connect must NOT be able to displace the legitimate request, and a
// popup window must only ever read/answer the exact request it was opened for. These tests pin the
// per-reqId keying that guarantees that.
import { describe, it, expect } from 'vitest';
import {
  requestApproval,
  openApproval,
  setApprovalPayload,
  cancelApproval,
  getPendingApproval,
  respondApproval,
  onApprovalWindowClosed,
} from '../src/background/dapp/approvals';

interface CreatedWindow {
  url: string;
  id: number;
}

/** Install a minimal in-memory chrome mock (storage.session + windows + runtime.getURL). */
function setupChromeMock(): { created: CreatedWindow[]; removed: number[] } {
  const session = new Map<string, unknown>();
  const created: CreatedWindow[] = [];
  const removed: number[] = [];
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
      remove: (id: number) => {
        removed.push(id);
        return Promise.resolve();
      },
    },
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
  };
  globalThis.chrome = mock as unknown as typeof chrome;
  return { created, removed };
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

describe('dApp approvals — two-phase signTx flow (instant window + pending payload, §1.5)', () => {
  it('openApproval(payloadPending) opens the window immediately with no payload yet', async () => {
    const { created } = setupChromeMock();
    const { reqId } = await openApproval('signTx', 'https://dapp.example', undefined, { payloadPending: true });
    expect(created).toHaveLength(1);
    const rec = await getPendingApproval(reqId);
    expect(rec).toMatchObject({ type: 'signTx', origin: 'https://dapp.example', payloadPending: true });
    expect(rec?.payload).toBeUndefined();
    await respondApproval(reqId, false); // clean up the waiter
  });

  it('an APPROVE while the payload is still pending is IGNORED — the blind-sign backstop', async () => {
    setupChromeMock();
    const { reqId, decision } = await openApproval('signTx', 'https://dapp.example', undefined, { payloadPending: true });

    await respondApproval(reqId, true); // popup bug / compromised renderer sends an early approve
    // ignored: the prompt is still pending, the decision unresolved
    expect(await getPendingApproval(reqId)).not.toBeNull();

    await setApprovalPayload(reqId, { fee: '170000' });
    const rec = await getPendingApproval(reqId);
    expect(rec?.payloadPending).toBe(false);
    expect(rec?.payload).toEqual({ fee: '170000' });

    await respondApproval(reqId, true); // now the summary is reviewable → approval counts
    await expect(decision).resolves.toBe(true);
    expect(await getPendingApproval(reqId)).toBeNull();
  });

  it('a DECLINE while the payload is pending works immediately, and a late payload cannot resurrect the record', async () => {
    setupChromeMock();
    const { reqId, decision } = await openApproval('signTx', 'https://dapp.example', undefined, { payloadPending: true });

    await respondApproval(reqId, false);
    await expect(decision).resolves.toBe(false);
    expect(await getPendingApproval(reqId)).toBeNull();

    await setApprovalPayload(reqId, { fee: '170000' }); // background finishes decoding afterwards
    expect(await getPendingApproval(reqId)).toBeNull(); // no orphan record re-created
  });

  it('cancelApproval closes the window and drops the record (chain work failed)', async () => {
    const { created, removed } = setupChromeMock();
    const { reqId } = await openApproval('signTx', 'https://dapp.example', undefined, { payloadPending: true });
    await cancelApproval(reqId);
    expect(removed).toEqual([created[0]?.id]);
    expect(await getPendingApproval(reqId)).toBeNull();
    // the closed window firing onRemoved afterwards must not blow up or touch other requests
    onApprovalWindowClosed(created[0]?.id ?? -1);
  });

  it('requestApproval (connect/signData) still delivers the payload up-front, not pending', async () => {
    const { created } = setupChromeMock();
    const p = requestApproval('signData', 'https://dapp.example', { address: 'addr_test1...', payloadHex: '00' });
    await new Promise((r) => setTimeout(r, 0));
    const rec = await getPendingApproval(reqIdOf(created[0]?.url ?? ''));
    expect(rec?.payloadPending).toBe(false);
    expect(rec?.payload).toMatchObject({ payloadHex: '00' });
    await respondApproval(rec?.reqId ?? '', true);
    await expect(p).resolves.toBe(true);
  });
});
