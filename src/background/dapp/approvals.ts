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

export const PENDING_APPROVAL_KEY = 'bob:pendingApproval';

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
  await chromeSessionStore.set(PENDING_APPROVAL_KEY, { reqId, type, origin, payload } satisfies PendingApproval);

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('src/popup/index.html#approve'),
    type: 'popup',
    width: 400,
    height: 620,
    focused: true,
  });

  return new Promise<boolean>((resolve) => {
    waiters.set(reqId, { resolve, windowId: win.id });
  });
}

export async function getPendingApproval(): Promise<PendingApproval | null> {
  return (await chromeSessionStore.get<PendingApproval>(PENDING_APPROVAL_KEY)) ?? null;
}

export async function respondApproval(reqId: string, approved: boolean): Promise<void> {
  const w = waiters.get(reqId);
  if (w) {
    waiters.delete(reqId);
    w.resolve(approved);
  }
  await chromeSessionStore.remove(PENDING_APPROVAL_KEY);
}

/** Called from a chrome.windows.onRemoved listener: a closed prompt counts as a decline. */
export function onApprovalWindowClosed(windowId: number): void {
  for (const [reqId, w] of waiters) {
    if (w.windowId === windowId) {
      waiters.delete(reqId);
      w.resolve(false);
      void chromeSessionStore.remove(PENDING_APPROVAL_KEY);
    }
  }
}
