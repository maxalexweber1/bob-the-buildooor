// dApp approval requests (EXECUTION_PLAN T4.1). A gated action (connect; signTx/signData) opens a
// trusted popup WINDOW, stores the pending request in chrome.storage.session for the popup to read,
// and awaits the user's decision. The resolver lives in SW memory; the dApp's open port keeps the SW
// alive during the prompt (IMPLEMENTATION_PLAN §4 rule 3). If the window is closed without a
// decision, we reject (treated as declined).
//
// Slow prompts (signTx) use a TWO-PHASE flow so the window appears instantly: openApproval() shows
// the window with `payloadPending: true` (the popup renders a spinner and keeps the approve button
// disabled), the background finishes decoding, then setApprovalPayload() fills in the summary. The
// decode-before-sign invariant (CLAUDE.md §1.5) is enforced HERE too, not just in the popup UI:
// respondApproval() refuses an approval while the payload is still pending.
import { chromeSessionStore } from '../storage';
import { approvalStorageKey } from '../../shared/internal';

export type ApprovalType = 'connect' | 'signTx' | 'signData';

export interface PendingApproval {
  reqId: string;
  type: ApprovalType;
  origin: string;
  /** Type-specific detail for the approval UI (e.g. a decoded tx summary). */
  payload?: unknown;
  /** True while the background is still preparing the payload (decoding/resolving a tx). The popup
   *  shows a spinner and MUST NOT allow approval until this clears (§1.5 decode-before-sign). */
  payloadPending?: boolean;
}

// Each pending approval is stored under its OWN reqId-scoped key, NOT a single shared key. This is a
// security boundary: a second gated request (e.g. a malicious dApp's signTx) must not be able to
// overwrite a legitimate pending request, and a popup window must only ever read/answer the exact
// request it was opened for. The window carries its reqId in the URL hash; the popup reads precisely
// that record (see Connect.tsx). Without per-reqId keying, two overlapping prompts race on one key —
// the legitimate one gets dropped and the attacker's can become the visible one (security review #1).
const approvalKey = approvalStorageKey;

interface Waiter {
  resolve: (approved: boolean) => void;
  windowId?: number | undefined;
}
const waiters = new Map<string, Waiter>();

export interface OpenedApproval {
  reqId: string;
  /** Resolves with the user's decision (false if the window is closed without one). */
  decision: Promise<boolean>;
}

/**
 * Open the approval window NOW and resolve the decision later. When `payload` is not yet known
 * (signTx decoding), pass `payloadPending: true` and deliver it via setApprovalPayload() — the
 * window opens immediately instead of after the chain round-trips.
 */
export async function openApproval(
  type: ApprovalType,
  origin: string,
  payload?: unknown,
  opts: { payloadPending?: boolean } = {},
): Promise<OpenedApproval> {
  const reqId = crypto.randomUUID();
  await chromeSessionStore.set(approvalKey(reqId), {
    reqId,
    type,
    origin,
    payload,
    payloadPending: opts.payloadPending === true,
  } satisfies PendingApproval);

  // reqId travels in the hash so the popup loads exactly this request, never "the latest".
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`src/popup/index.html#approve?req=${reqId}`),
    type: 'popup',
    width: 400,
    height: 620,
    focused: true,
  });

  const decision = new Promise<boolean>((resolve) => {
    waiters.set(reqId, { resolve, windowId: win.id });
  });
  return { reqId, decision };
}

/** Open the approval prompt and resolve true/false once the user decides (false if window closed). */
export async function requestApproval(
  type: ApprovalType,
  origin: string,
  payload?: unknown,
): Promise<boolean> {
  return (await openApproval(type, origin, payload)).decision;
}

/**
 * Deliver the decoded payload of a two-phase approval. The popup watches this record's storage key
 * and swaps its spinner for the summary. A no-op if the record is gone (user already closed/declined
 * the window — the decision promise carries that outcome).
 */
export async function setApprovalPayload(reqId: string, payload: unknown): Promise<void> {
  const rec = await chromeSessionStore.get<PendingApproval>(approvalKey(reqId));
  // The waiters check narrows the decline-vs-deliver race: if the user already answered (waiter
  // gone), don't re-create the record respondApproval just removed.
  if (!rec || !waiters.has(reqId)) return;
  await chromeSessionStore.set(approvalKey(reqId), { ...rec, payload, payloadPending: false });
}

/**
 * Abandon a two-phase approval whose background work failed (e.g. inputs unresolvable): close the
 * window, drop the record and the waiter. The caller throws its own error to the dApp — the decision
 * promise is intentionally left unresolved (nobody awaits it after cancel).
 */
export async function cancelApproval(reqId: string): Promise<void> {
  const w = waiters.get(reqId);
  waiters.delete(reqId); // before windows.remove so onApprovalWindowClosed can't double-handle it
  await chromeSessionStore.remove(approvalKey(reqId));
  if (w?.windowId !== undefined) {
    try {
      await chrome.windows.remove(w.windowId);
    } catch {
      // window already closed by the user — nothing to do
    }
  }
}

export async function getPendingApproval(reqId: string): Promise<PendingApproval | null> {
  if (!reqId) return null;
  return (await chromeSessionStore.get<PendingApproval>(approvalKey(reqId))) ?? null;
}

export async function respondApproval(reqId: string, approved: boolean): Promise<void> {
  // Decode-before-sign backstop (§1.5): an approval is only valid once the payload the user must
  // review actually exists. The popup disables the button while pending; this guard makes the
  // invariant hold even if a popup bug (or a compromised renderer) sends an early approve.
  if (approved) {
    const rec = await chromeSessionStore.get<PendingApproval>(approvalKey(reqId));
    if (rec?.payloadPending) return; // ignore — the prompt stays open, the user decides later
  }
  const w = waiters.get(reqId);
  if (w) {
    waiters.delete(reqId);
    w.resolve(approved);
  }
  // Only clears THIS request's record — other concurrent prompts are untouched.
  await chromeSessionStore.remove(approvalKey(reqId));
}

/** Called from a chrome.windows.onRemoved listener: a closed prompt counts as a decline. */
export function onApprovalWindowClosed(windowId: number): void {
  for (const [reqId, w] of waiters) {
    if (w.windowId === windowId) {
      waiters.delete(reqId);
      w.resolve(false);
      void chromeSessionStore.remove(approvalKey(reqId));
    }
  }
}
