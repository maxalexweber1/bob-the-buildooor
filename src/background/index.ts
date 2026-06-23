// Service worker = the wallet core. EPHEMERAL: terminated after ~30s idle.
// NEVER hold decrypted keys or unlock state in module globals (IMPLEMENTATION_PLAN §5).
import { TARGET_INPAGE, DAPP_PORT, type RpcRequest, type RpcResponse } from '../shared/messages';
import { isInternalRequest, type InternalResult } from '../shared/internal';
import { Cip30Error, PaginateError } from '../shared/errors';
import { initAutoLock } from './autolock';
import { handleWalletCommand } from './walletHandlers';
import { isTrustedExtensionSender } from './senderTrust';
import { handleCip30 } from './cip30/handlers';
import { onApprovalWindowClosed } from './dapp/approvals';

// Register lock triggers synchronously on every SW start (MV3: listeners must be top-level).
void initAutoLock();

// ---- Privileged internal commands (popup/options only), one-shot messaging ----
chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
  if (!isInternalRequest(msg)) return false;
  if (!isTrustedExtensionSender(sender, chrome.runtime.id)) {
    // Diagnostic: surface the sender shape (metadata only, no secrets) to pinpoint trust mismatches.
    const diag = `id=${sender.id} origin=${sender.origin ?? '∅'} url=${sender.url ?? '∅'}`;
    sendResponse({ ok: false, error: `untrusted sender [${diag}]` } satisfies InternalResult);
    return false;
  }
  handleWalletCommand(msg.command)
    .then((data) => sendResponse({ ok: true, data } satisfies InternalResult))
    .catch((e: unknown) =>
      sendResponse({ ok: false, error: e instanceof Error ? e.message : 'InternalError' } satisfies InternalResult),
    );
  return true; // async response
});

// ---- dApp CIP-30 bridge over a long-lived port (keeps the SW alive during approval) ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== DAPP_PORT) return;
  // The authoritative origin is Chrome's `sender.origin` for the content script's page — NOT anything
  // the page (or a compromised content script) puts in the message (CLAUDE.md §1.6).
  const trustedOrigin = port.sender?.origin ?? '';

  port.onMessage.addListener((req: RpcRequest) => {
    const respond = (r: Omit<RpcResponse, 'target'>) => port.postMessage({ target: TARGET_INPAGE, ...r });
    handleCip30(req.method, req.params ?? [], trustedOrigin)
      .then((result) => respond({ id: req.id, result }))
      .catch((err: unknown) => respond({ id: req.id, error: toCip30Wire(err) }));
  });
});

// A closed approval prompt counts as a decline.
chrome.windows.onRemoved.addListener(onApprovalWindowClosed);

function toCip30Wire(err: unknown): { code: number; info: string } | { maxSize: number } {
  if (err instanceof PaginateError) return { maxSize: err.maxSize };
  if (err instanceof Cip30Error) return { code: err.code, info: err.info };
  if (err && typeof (err as { code?: unknown }).code === 'number') {
    const e = err as { code: number; info?: unknown };
    return { code: e.code, info: String(e.info ?? '') };
  }
  return { code: -2, info: err instanceof Error ? err.message : 'InternalError' };
}
