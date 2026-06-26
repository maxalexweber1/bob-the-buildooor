// ADA Handle resolution (EXECUTION_PLAN T8.1). Resolve a `$handle` to the address that currently
// holds the handle NFT, so the Send recipient field accepts a handle in place of a bech32 address.
//
// Framework-free and provider-agnostic: the on-chain lookup is injected as `AssetAddressLookup` so this
// module stays reusable from both the SW and the popup with no dependency on the provider layer.
//
// Security (CLAUDE.md §1.5/§1.6 — this picks the address funds go to):
//  - POLICY = IDENTITY. We only ever look up assets under the official `HANDLE_POLICY_ID`. A token with
//    the same name under any other policy is NOT a handle. The policy id is the anti-spoof anchor.
//  - VALIDATE BEFORE ENCODING. The handle string is checked against the ADA Handle charset/length rules
//    before it is hex-encoded into an asset name — never build a unit out of arbitrary bytes.
//  - SINGLE HOLDER. A handle is an NFT (supply 1) → exactly one holding address. Zero holders → not
//    minted / not found; more than one → ambiguous/suspect → reject (never silently pick one).
//  - The caller (Send UI) MUST show the resolved address for the user to verify, and the signing
//    approval re-renders the real output address (decode-before-sign). The handle is input convenience
//    only; the user always approves the concrete address.
import { encodeCip67 } from './cip67';
import { utf8ToBytes, toHex } from './crypto/encoding';

/**
 * The official ADA Handle minting policy id. It is **network-independent** — the same id on mainnet,
 * preprod and preview (a Cardano policy id is the hash of the minting script, which Koralabs deploys
 * identically on every network). One constant, no per-network table. The set of *minted* handles still
 * differs per network, but that falls out of querying the active network's provider.
 */
export const HANDLE_POLICY_ID = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';

/** CIP-68 user-token (222) label — the encoding used for handles minted after the CIP-68 migration. */
const HANDLE_CIP68_LABEL = 222;

// ADA Handle root-handle rules: lowercase ASCII letters/digits and `-` `_` `.`, 1–15 bytes. (SubHandles
// — names containing `@` — resolve differently, via the reference token's datum, and are out of scope.)
const HANDLE_RE = /^[a-z0-9._-]{1,15}$/;

/** A single address holding an asset, with its quantity (decimal string). */
export interface AssetHolder {
  address: string;
  quantity: string;
}

/** The one on-chain capability handle resolution needs: who currently holds asset `unit`. */
export interface AssetAddressLookup {
  /** Addresses holding `unit` (policyId + assetNameHex), with quantities. */
  getAssetAddresses(unit: string): Promise<AssetHolder[]>;
}

/** A handle resolved to its current on-chain holder. */
export interface ResolvedHandle {
  /** The normalized bare handle (no `$`, lowercased). */
  handle: string;
  /** The bech32 address currently holding the handle NFT. */
  address: string;
}

/** Resolution failed in a way worth surfacing verbatim to the user (distinct from a network error). */
export class HandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandleError';
  }
}

/**
 * Does this input look like a handle attempt (rather than an address)? True iff it starts with `$`.
 * Used by the UI to decide whether to resolve vs. treat the text as a literal address — it does NOT
 * assert validity (an invalid `$..` still returns true so the user gets a "bad handle" message).
 */
export function looksLikeHandle(input: string): boolean {
  return input.trim().startsWith('$');
}

/**
 * Normalize and validate a handle. Strips one leading `$`, lowercases, and checks the ADA Handle
 * charset/length rules. Returns the bare handle, or null if it is not a valid root handle.
 */
export function normalizeHandle(input: string): string | null {
  let h = input.trim();
  if (h.startsWith('$')) h = h.slice(1);
  h = h.toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}

/**
 * The two candidate asset units a handle could be held under: the CIP-68 (222) form (new mints) and the
 * legacy CIP-25 raw-hex form (original handles). Both live under the same `HANDLE_POLICY_ID`. `name`
 * must already be a normalized, validated handle.
 */
export function handleToUnits(name: string): { cip68: string; legacy: string } {
  const nameHex = toHex(utf8ToBytes(name));
  return {
    cip68: HANDLE_POLICY_ID + encodeCip67(HANDLE_CIP68_LABEL, nameHex),
    legacy: HANDLE_POLICY_ID + nameHex,
  };
}

/**
 * Resolve `$handle` to the address that currently holds it. Tries the CIP-68 (222) unit first, then the
 * legacy unit. Enforces the single-holder rule. Throws {@link HandleError} for invalid/not-found/
 * ambiguous handles; provider/network errors propagate as-is.
 */
export async function resolveHandle(input: string, lookup: AssetAddressLookup): Promise<ResolvedHandle> {
  const handle = normalizeHandle(input);
  if (handle === null) {
    throw new HandleError('Not a valid ADA Handle (use $ + up to 15 of a–z, 0–9, -, _, .)');
  }
  const { cip68, legacy } = handleToUnits(handle);

  // CIP-68 first (the current mint format), then the legacy raw-name form.
  for (const unit of [cip68, legacy]) {
    const holders = (await lookup.getAssetAddresses(unit)).filter((h) => h.quantity !== '0' && h.address);
    if (holders.length === 0) continue;
    if (holders.length > 1) {
      // An NFT must have exactly one holder. Multiple → don't guess where funds go.
      throw new HandleError(`$${handle} is ambiguous (held by ${holders.length} addresses) — resolve manually`);
    }
    const [sole] = holders; // exactly one here; the check narrows away `undefined` without a `!`
    if (sole) return { handle, address: sole.address };
  }
  throw new HandleError(`$${handle} is not minted on this network`);
}
