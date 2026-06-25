import { describe, it, expect } from 'vitest';
import { parseCip67, cip67LabelName } from '../src/core/cip67';

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');

// Prefixes computed from the CIP-67 algorithm; 222 → 000de140 matches the spec's worked example.
const PFX = { ref: '000643b0', nft: '000de140', ft: '0014df10', rft: '001bc280' } as const;

describe('parseCip67 (standards review)', () => {
  it('parses the spec example label 222 and strips the prefix', () => {
    expect(parseCip67(PFX.nft + hex('Test'))).toEqual({ label: 222, contentHex: hex('Test') });
  });

  it('parses the CIP-68 label set (100/222/333/444)', () => {
    expect(parseCip67(PFX.ref + hex('x'))?.label).toBe(100);
    expect(parseCip67(PFX.nft + hex('x'))?.label).toBe(222);
    expect(parseCip67(PFX.ft + hex('x'))?.label).toBe(333);
    expect(parseCip67(PFX.rft + hex('x'))?.label).toBe(444);
  });

  it('handles an empty content (label-only name)', () => {
    expect(parseCip67(PFX.nft)).toEqual({ label: 222, contentHex: '' });
  });

  it('rejects a prefix whose CRC-8 does not match (guards against false strips)', () => {
    // 222 prefix with the checksum byte corrupted (40 → 41 in the last byte's high nibble region).
    expect(parseCip67('000de150' + hex('Test'))).toBeUndefined();
  });

  it('rejects a malformed frame (leading/trailing nibble not zero)', () => {
    expect(parseCip67('100de140' + hex('x'))).toBeUndefined(); // high nibble of b0 ≠ 0
    expect(parseCip67('000de141' + hex('x'))).toBeUndefined(); // low nibble of b3 ≠ 0
  });

  it('returns undefined for ordinary asset names (no valid prefix)', () => {
    expect(parseCip67(hex('PIZZA'))).toBeUndefined();
    expect(parseCip67('')).toBeUndefined();
    expect(parseCip67('00de')).toBeUndefined(); // too short
    expect(parseCip67('zzzzzzzz')).toBeUndefined(); // not hex
  });
});

describe('cip67LabelName', () => {
  it('maps the standard CIP-68 token classes', () => {
    expect(cip67LabelName(100)).toBe('ref');
    expect(cip67LabelName(222)).toBe('NFT');
    expect(cip67LabelName(333)).toBe('FT');
    expect(cip67LabelName(444)).toBe('RFT');
  });

  it('returns undefined for unknown labels', () => {
    expect(cip67LabelName(0)).toBeUndefined();
    expect(cip67LabelName(999)).toBeUndefined();
  });
});
