// Sender-trust gate for privileged internal commands (T1.7). A security boundary: only our own
// extension pages (popup/options) may invoke create/unlock/derive — never a content script / dApp
// (CLAUDE.md §1.4/§1.6). Pure & injectable (takes the extension id) so it's unit-tested without chrome.

export interface MinimalSender {
  id?: string | undefined;
  url?: string | undefined;
  origin?: string | undefined;
}

/**
 * Trusted iff the message is from THIS extension AND it came from our own extension origin
 * (`chrome-extension://<id>`). We discriminate by ORIGIN/URL, never by the absence of a tab: the
 * options page opens in a tab yet is fully trusted, while a content script always carries the web
 * page's `https://…` origin (never our extension origin). Chrome populates `origin` and/or `url`
 * depending on context, so we accept either.
 */
export function isTrustedExtensionSender(sender: MinimalSender, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  const ext = `chrome-extension://${extensionId}`;
  return sender.origin === ext || (sender.url?.startsWith(`${ext}/`) ?? false);
}
