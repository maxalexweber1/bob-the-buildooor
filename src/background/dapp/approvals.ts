// dApp approval requests (EXECUTION_PLAN T4.1). A gated action (connect now; signTx/signData in M4
// part 2) opens a trusted popup WINDOW, stores the pending request in chrome.storage.session for the
// popup to read, and awaits the user's decision. The resolver lives in SW memory; the dApp's open
// port keeps the SW alive during the prompt (IMPLEMENTATION_PLAN §4 rule 3). If the window is closed
// without a decision, we reject (treated as declined).
import { chromeSessionStore } from '../storage';

export type ApprovalType = 'connect' | 'signTx' | 'signData';

export interface PendingApproval {
  reqId: string;
  type: ApprovalType;
  origin: string;
  /** Type-specific detail for the approval UI (e.g. a decoded tx summary). */
  payload?: unknown;
}

// Each pending approval is stored under its OWN reqId-scoped key, NOT a single shared key. This is a
// security boundary: a second gated request (e.g. a malicious dApp's signTx) must not be able to
// overwrite a legitimate pending request, and a popup window must only ever read/answer the exact
// request it was opened for. The window carries its reqId in the URL hash; the popup reads precisely
// that record (see Connect.tsx). Without per-reqId keying, two overlapping prompts race on one key —
// the legitimate one gets dropped and the attacker's can become the visible one (security review #1).
const APPROVAL_KEY_PREFIX = 'bob:pendingApproval:';
const approvalKey = (reqId: string): string => `${APPROVAL_KEY_PREFIX}${reqId}`;

interface Waiter {
  resolve: (approved: boolean) => void;
  windowId?: number | undefined;
}
const waiters = new Map<string, Waiter>();

/** Open the approval prompt and resolve true/false once the user decides (false if window closed). */
export async function requestApproval(
  type: ApprovalType,
  origin: string,
  payload?: unknown,
): Promise<boolean> {
  const reqId = crypto.randomUUID();
  await chromeSessionStore.set(approvalKey(reqId), { reqId, type, origin, payload } satisfies PendingApproval);

  // reqId travels in the hash so the popup loads exactly this request, never "the latest".
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`src/popup/index.html#approve?req=${reqId}`),
    type: 'popup',
    width: 400,
    height: 620,
    focused: true,
  });

  return new Promise<boolean>((resolve) => {
    waiters.set(reqId, { resolve, windowId: win.id });
  });
}

export async function getPendingApproval(reqId: string): Promise<PendingApproval | null> {
  if (!reqId) return null;
  return (await chromeSessionStore.get<PendingApproval>(approvalKey(reqId))) ?? null;
}

export async function respondApproval(reqId: string, approved: boolean): Promise<void> {
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
