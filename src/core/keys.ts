// Pure HD-key derivation (EXECUTION_PLAN T1.3/T1.4). Framework-free, no storage, no chrome.*.
// Storage/lifetime of the resulting key material is the vault's job (background) — see CLAUDE.md §1.
//
// API NOTE: symbol names below were taken from the installed @harmoniclabs/buildooor .d.ts files.
// Verify against the version you install (T1.4) — especially the Credential/Address assembly,
// which is exercised by the `it.todo` known-address vector in test/keys.test.ts.
import { XPrv, harden } from '@harmoniclabs/buildooor';
import { mnemonicToEntropy } from './mnemonic';

export const PURPOSE = 1852; // CIP-1852
export const COIN_TYPE = 1815; // ADA

/** CIP-1852 / CIP-105 roles. */
export const Role = {
  External: 0,
  Internal: 1,
  Staking: 2,
  DRep: 3,
  CommitteeCold: 4,
  CommitteeHot: 5,
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Mnemonic → BIP32-Ed25519 root key. Throws on an invalid mnemonic. */
export function mnemonicToRoot(mnemonic: string, passphrase?: string): XPrv {
  const entropy = mnemonicToEntropy(mnemonic);
  return XPrv.fromEntropy(entropy, passphrase);
}

/** Derive the account-level key `m / 1852' / 1815' / account'`. Reuse it across addresses (the
 *  account prefix is the same for every address) — buildooor's per-step derivation is expensive. */
export function deriveAccountKey(root: XPrv, account: number): XPrv {
  return root.derive(harden(PURPOSE)).derive(harden(COIN_TYPE)).derive(harden(account));
}

/** Derive `role / index` from a precomputed account key (the cheap, per-address part). */
export function deriveFromAccount(accountKey: XPrv, role: number, index: number): XPrv {
  return accountKey.derive(role).derive(index);
}

/** Derive `m / 1852' / 1815' / account' / role / index`. */
export function deriveKey(root: XPrv, account: number, role: number, index: number): XPrv {
  return deriveFromAccount(deriveAccountKey(root, account), role, index);
}

/** Raw Ed25519 public-key bytes (32) for a derived path. */
export function publicKeyBytes(root: XPrv, account: number, role: number, index: number): Uint8Array {
  return deriveKey(root, account, role, index).public().toPubKeyBytes();
}
