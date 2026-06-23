import { describe, it, expect } from 'vitest';
import { mnemonicToEntropy, entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { mnemonicToRoot, publicKeyBytes, Role } from '../src/core/keys';

// Standard BIP39 test vector: 32 zero bytes of entropy → the canonical 24-word phrase
// ending in "art". This is the well-known Trezor vector and needs no network.
const ZERO_ENTROPY_24 =
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon art';

describe('BIP39 (@scure/bip39)', () => {
  it('round-trips the all-zero 256-bit entropy vector', () => {
    expect(validateMnemonic(ZERO_ENTROPY_24, wordlist)).toBe(true);

    const entropy = mnemonicToEntropy(ZERO_ENTROPY_24, wordlist);
    expect(entropy.length).toBe(32);
    expect([...entropy].every((b) => b === 0)).toBe(true);

    expect(entropyToMnemonic(entropy, wordlist)).toBe(ZERO_ENTROPY_24);
  });

  it('rejects an invalid mnemonic (bad checksum)', () => {
    const bad = ZERO_ENTROPY_24.replace(/art$/, 'abandon');
    expect(validateMnemonic(bad, wordlist)).toBe(false);
    expect(() => mnemonicToRoot(bad)).toThrow();
  });
});

describe('CIP-1852 derivation (buildooor XPrv)', () => {
  it('is deterministic for the same mnemonic', () => {
    const a = publicKeyBytes(mnemonicToRoot(ZERO_ENTROPY_24), 0, Role.External, 0);
    const b = publicKeyBytes(mnemonicToRoot(ZERO_ENTROPY_24), 0, Role.External, 0);
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  it('derives a 32-byte Ed25519 public key', () => {
    const pk = publicKeyBytes(mnemonicToRoot(ZERO_ENTROPY_24), 0, Role.External, 0);
    expect(pk.length).toBe(32);
  });

  it('yields distinct keys per role and index', () => {
    const root = mnemonicToRoot(ZERO_ENTROPY_24);
    const ext0 = Buffer.from(publicKeyBytes(root, 0, Role.External, 0)).toString('hex');
    const ext1 = Buffer.from(publicKeyBytes(root, 0, Role.External, 1)).toString('hex');
    const stake = Buffer.from(publicKeyBytes(root, 0, Role.Staking, 0)).toString('hex');
    expect(new Set([ext0, ext1, stake]).size).toBe(3);
  });

  // Base-address known-vector coverage lives in test/address.test.ts (T1.4).
});
