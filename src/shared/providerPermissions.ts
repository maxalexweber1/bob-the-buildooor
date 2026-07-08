// Runtime host-permission helper for custom provider endpoints (T2.3/T7.5).
// A custom/self-hosted provider host (Koios, Kupo) is not in the static manifest host_permissions,
// so the SW fetch would be blocked — it must be granted at runtime via chrome.permissions.request,
// which only works inside a user gesture (the Save/Test click). PRIVILEGED contexts only (popup /
// options): never import this from inpage/ or content/ (no chrome.permissions there anyway).

/**
 * URL → extension origin match pattern covering its host, e.g.
 * `https://user:pw@host:8080/x?q=1` → `https://host/*` (match patterns have no port/creds/path).
 * Returns null for unparseable input or non-http(s) schemes (ws:// Ogmios needs no host permission).
 */
export function hostMatchPattern(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Ensure the optional host permission for a custom provider URL, prompting if needed. Returns
 * `true` when granted or nothing needs requesting; `false` when the user denied it — callers MUST
 * surface that as a visible configuration error, not save silently and fail later in the SW.
 */
export async function ensureHostPermission(url: string | undefined): Promise<boolean> {
  if (!url?.trim()) return true;
  const pattern = hostMatchPattern(url);
  if (pattern === null) return true; // not requestable — the save/test flow surfaces its own error
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
