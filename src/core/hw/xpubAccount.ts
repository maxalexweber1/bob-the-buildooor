// Hardware-wallet account derivation (EXECUTION_PLAN T6.3). A hardware account is defined by its
// CIP-1852 account-level EXTENDED PUBLIC KEY (m/1852'/1815'/account'), exported once from the device.
// Everything the wallet needs for watch-only operation — payment/stake public keys, base addresses,
// the reward address — derives from that xpub via SOFT (non-hardened) BIP32-Ed25519 derivation.
// No private material ever exists in the browser (CLAUDE.md §1.1): the device keeps the keys, we keep
// 64 public bytes. Witness signatures coming back from the device are verified against these same
// derived public keys before anything is submitted (trust-no-input — see ledgerTx.ts).
//
// Pure & framework-free (buildooor only).
import { Address, Credential, StakeCredentials, XPub } from '@harmoniclabs/buildooor';
import { keyHash28, type Network, type PaymentRole } from '../address';
import { Role } from '../keys';
import { fromHex } from '../crypto/encoding';

/** An account xpub is 64 bytes: 32-byte Ed25519 public key || 32-byte chain code → 128 hex chars. */
const XPUB_HEX_RE = /^[0-9a-f]{128}$/i;

/**
 * Parse + validate an account-level xpub (raw `publicKey || chainCode` hex, as returned by the
 * Ledger app's getExtendedPublicKey). Throws on malformed input — this comes from a device/storage
 * round-trip and must never be trusted blindly.
 */
export function parseAccountXpub(xpubHex: string): XPub {
  if (!XPUB_HEX_RE.test(xpubHex)) {
    throw new Error('invalid account xpub (expected 128 hex chars: publicKey || chainCode)');
  }
  return new XPub(fromHex(xpubHex));
}

/**
 * Reusable per-account derivation context for a hardware account — the xpub analog of
 * `AccountKeys` (core/address.ts): the stake credential is derived once and shared by every address.
 */
export interface HwAccountKeys {
  accountXpub: XPub;
  stakeKeyHash: Uint8Array;
  stakeCredential: StakeCredentials;
}

export function hwAccountKeys(xpubHex: string): HwAccountKeys {
  const accountXpub = parseAccountXpub(xpubHex);
  const stakeKeyHash = keyHash28(accountXpub.derive(Role.Staking).derive(0).toPubKeyBytes());
  return { accountXpub, stakeKeyHash, stakeCredential: StakeCredentials.keyHash(stakeKeyHash) };
}

/** Soft-derived public key bytes for `role/index` under the account xpub. */
export function hwPublicKey(keys: HwAccountKeys, role: number, index: number): Uint8Array {
  return keys.accountXpub.derive(role).derive(index).toPubKeyBytes();
}

/** Base address for `index` on the given payment chain — same shape as `baseAddressFrom`. */
export function hwBaseAddress(
  keys: HwAccountKeys,
  network: Network,
  index: number,
  role: PaymentRole = Role.External,
): string {
  const pay = Credential.keyHash(keyHash28(hwPublicKey(keys, role, index)));
  const addr = network === 'mainnet' ? Address.mainnet(pay, keys.stakeCredential) : Address.testnet(pay, keys.stakeCredential);
  return addr.toString();
}

/**
 * Verify a device-produced Ed25519 signature against the soft-derived public key for `role/index`.
 * This is the integrity gate for hardware witnesses: a witness that does not verify against OUR
 * transaction hash is rejected — whatever the device signed, it was not the tx the user approved.
 */
export function verifyHwSignature(
  keys: HwAccountKeys,
  role: number,
  index: number,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    return keys.accountXpub.derive(role).derive(index).verify(message, signature);
  } catch {
    // A malformed signature (e.g. bytes that aren't a curve point) makes the crypto layer throw —
    // that is a failed verification, not an internal error: reject cleanly.
    return false;
  }
}
