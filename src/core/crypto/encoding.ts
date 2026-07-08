// Pure byte/encoding helpers shared by the crypto wrappers (T1.2).
// Framework-free, no chrome.*, no secrets retained. Works in the SW, popup, and Node (tests):
// btoa/atob and TextEncoder/TextDecoder are all global in those environments.

// Spread chunk size kept under the engine arg-count limit for String.fromCharCode(...).
const CHUNK = 0x8000;

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Copy `bytes` into a fresh standalone `ArrayBuffer`. Used at the WebCrypto boundary: since TS 5.7
 * typed arrays are generic over `ArrayBufferLike`, but `crypto.subtle.*` requires an `ArrayBuffer`-
 * backed `BufferSource`. The copy also defends against the caller mutating the input mid-operation.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  // Iterate by value so each byte is a definite `number` — no `?? 0` coercion that could silently
  // emit "00" for an out-of-range index (review #-nit).
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

/**
 * STRICT hex decode. `parseInt` must never see this input: it coerces garbage ('zz' → NaN → 0x00),
 * which for signing paths means signing DIFFERENT bytes than the caller sent instead of rejecting
 * (CLAUDE.md §1.6 trust-no-input). Errors never echo the input (no secrets).
 */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('odd-length hex string');
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('invalid hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
