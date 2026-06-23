// BIP39 layer (EXECUTION_PLAN T1.3). The one gap the HarmonicLabs stack doesn't cover — we use
// @scure/bip39 (audited, pure-JS) for the wordlist + generate/validate. Framework-free, no chrome.*.
//
// SECURITY: the mnemonic and entropy returned here are seed-equivalent secrets. Callers must keep
// them in transient scope only, never log them, and hand them to the vault for encryption at rest
// (CLAUDE.md §1). This module itself retains nothing.
import {
  generateMnemonic as scureGenerate,
  validateMnemonic as scureValidate,
  mnemonicToEntropy as scureToEntropy,
  entropyToMnemonic as scureFromEntropy,
} from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/** Wallet default: 256-bit entropy → 24 words. Maximum standard BIP39 strength. */
export const MNEMONIC_STRENGTH_BITS = 256;

/** Generate a fresh mnemonic. Entropy comes from @scure (crypto.getRandomValues under the hood). */
export function generateMnemonic(strengthBits: number = MNEMONIC_STRENGTH_BITS): string {
  return scureGenerate(wordlist, strengthBits);
}

/** True iff `mnemonic` is in-wordlist with a valid checksum. */
export function isValidMnemonic(mnemonic: string): boolean {
  return scureValidate(mnemonic, wordlist);
}

/** Mnemonic → entropy bytes. Throws on an invalid mnemonic (bad word or checksum). */
export function mnemonicToEntropy(mnemonic: string): Uint8Array {
  if (!isValidMnemonic(mnemonic)) throw new Error('invalid mnemonic');
  return scureToEntropy(mnemonic, wordlist);
}

/** Entropy bytes → mnemonic. Throws if the entropy length is not a supported size. */
export function entropyToMnemonic(entropy: Uint8Array): string {
  return scureFromEntropy(entropy, wordlist);
}
