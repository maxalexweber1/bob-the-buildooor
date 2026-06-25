// CIP-20 transaction message/memo decoder (standards review round 2). Surfaces the human-readable
// memo a tx carries so the approval UI and history can SHOW it instead of just flagging "metadata
// present" (CLAUDE.md §1.5 — never blind-sign; the more we decode, the less the user approves blind).
//
// CIP-20: metadata label 674 holds a map with a "msg" key whose value is an array of UTF-8 strings,
// each ≤64 bytes. CIP-83 adds an optional "enc" key signalling the message body is ENCRYPTED — we do
// not decrypt it, but we MUST flag it so ciphertext is never shown as if it were a readable memo.
//
// Input is the buildooor `TxMetadata.toJson()` shape, which encodes a metadatum map as
//   { "674": [ { k: {text:"msg"}, v: [ {text:"line 1"}, {text:"line 2"} ] }, ... ] }
// All input is from an untrusted dApp tx — every level is validated, never assumed (CLAUDE.md §6).

/** Tx metadata label for CIP-20 messages (T9 encoding of "msg"). CIP-83 reuses the same label. */
export const CIP20_MESSAGE_LABEL = '674';

export interface TxMessage {
  /** Decoded CIP-20 message lines (the "msg" array). Empty only when the message is encrypted-only. */
  lines: string[];
  /** CIP-83: the body is encrypted (an "enc" key is present). We surface the flag, not a fake plaintext. */
  encrypted: boolean;
}

/** A metadatum text node is `{ text: "…" }` in buildooor's JSON. */
function metadatumText(m: unknown): string | undefined {
  if (typeof m === 'object' && m !== null && 'text' in m) {
    const t = (m as { text: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return undefined;
}

/** A metadatum map is `[{ k, v }, …]`; return only the well-formed entries. */
function mapEntries(m: unknown): Array<{ k: unknown; v: unknown }> {
  if (!Array.isArray(m)) return [];
  return m.filter(
    (e): e is { k: unknown; v: unknown } =>
      typeof e === 'object' && e !== null && 'k' in e && 'v' in e,
  );
}

/** Value of the first map entry whose key is the given text, else undefined. */
function valueForKey(entries: Array<{ k: unknown; v: unknown }>, keyText: string): unknown {
  for (const e of entries) if (metadatumText(e.k) === keyText) return e.v;
  return undefined;
}

/** A "msg" value is a list of text nodes (canonical) or, leniently, a single text node. */
function textLines(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(metadatumText).filter((s): s is string => s !== undefined);
  }
  const single = metadatumText(v);
  return single !== undefined ? [single] : [];
}

/**
 * Decode a CIP-20 message (label 674) from a `TxMetadata.toJson()` result. Returns undefined when
 * there is no message to show. Tolerant of malformed/partial metadata — never throws.
 */
export function decodeTxMessage(metadataJson: unknown): TxMessage | undefined {
  if (typeof metadataJson !== 'object' || metadataJson === null) return undefined;
  const label = (metadataJson as Record<string, unknown>)[CIP20_MESSAGE_LABEL];
  const entries = mapEntries(label);
  if (entries.length === 0) return undefined;

  const lines = textLines(valueForKey(entries, 'msg'));
  const encrypted = valueForKey(entries, 'enc') !== undefined; // CIP-83 marker
  if (lines.length === 0 && !encrypted) return undefined;
  return { lines, encrypted };
}
