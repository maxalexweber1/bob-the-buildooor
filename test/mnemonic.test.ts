import { describe, it, expect } from 'vitest';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  generateMnemonic,
  isValidMnemonic,
  mnemonicToEntropy,
  entropyToMnemonic,
  MNEMONIC_STRENGTH_BITS,
} from '../src/core/mnemonic';

// Canonical BIP39 (Trezor) entropy↔mnemonic vectors — hex entropy → expected phrase.
// https://github.com/trezor/python-mnemonic/blob/master/vectors.json
const VECTORS: ReadonlyArray<readonly [hex: string, phrase: string]> = [
  ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
  ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
  ['0000000000000000000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote'],
];

const fromHex = (h: string): Uint8Array =>
  new Uint8Array((h.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));

describe('BIP39 known vectors (T1.3 done-when)', () => {
  it.each(VECTORS)('entropy %s → expected mnemonic (both directions)', (hex, phrase) => {
    const entropy = fromHex(hex);
    expect(entropyToMnemonic(entropy)).toBe(phrase);
    expect([...mnemonicToEntropy(phrase)]).toEqual([...entropy]);
    expect(isValidMnemonic(phrase)).toBe(true);
  });
});

describe('generateMnemonic', () => {
  it('defaults to a valid 24-word (256-bit) phrase, all in-wordlist', () => {
    expect(MNEMONIC_STRENGTH_BITS).toBe(256);
    const m = generateMnemonic();
    const words = m.split(' ');
    expect(words.length).toBe(24);
    expect(words.every((w) => wordlist.includes(w))).toBe(true);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('can generate a 12-word (128-bit) phrase', () => {
    expect(generateMnemonic(128).split(' ').length).toBe(12);
  });

  it('produces a fresh phrase each call (not constant)', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic());
  });
});

describe('validation', () => {
  it('rejects a bad-checksum phrase', () => {
    const bad = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    expect(isValidMnemonic(bad)).toBe(false);
    expect(() => mnemonicToEntropy(bad)).toThrow(/invalid mnemonic/);
  });

  it('rejects an out-of-wordlist word', () => {
    expect(isValidMnemonic('abandon abandon notaword')).toBe(false);
  });
});
