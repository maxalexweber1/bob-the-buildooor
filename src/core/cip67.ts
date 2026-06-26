// CIP-67 asset-name label parser (standards review round 2). CIP-68 tokens carry a 4-byte label
// prefix on their asset name (e.g. 222 = NFT, 333 = FT, 444 = RFT, 100 = reference NFT). Stripping it
// lets the wallet show a readable token name instead of leading prefix bytes that aren't printable.
//
// Prefix layout (4 bytes / 8 hex):  [ 0000 | 16-bit label_num | 8-bit CRC-8 | 0000 ]
// The checksum is CRC-8/SMBUS (poly 0x07, init 0x00, no reflection) over the 2 label-number bytes —
// verified against the spec's worked example (label 222 → prefix 000de140, checksum 0x14). We REQUIRE
// the checksum to match so a coincidental 8-hex prefix on an ordinary asset name isn't mis-stripped.
/** CRC-8/SMBUS over the given bytes. */
function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

export interface Cip67Label {
  /** The decoded label number (e.g. 100, 222, 333, 444). */
  label: number;
  /** The asset name with the 4-byte CIP-67 prefix removed (hex). */
  contentHex: string;
}

/**
 * Parse a CIP-67 label prefix off an asset name (hex). Returns undefined when the name does not carry
 * a valid prefix (wrong length, wrong frame nibbles, or — crucially — a CRC-8 mismatch). Pure & total.
 */
export function parseCip67(assetNameHex: string): Cip67Label | undefined {
  if (assetNameHex.length < 8 || !/^[0-9a-f]{8}/i.test(assetNameHex)) return undefined;
  const p = assetNameHex.slice(0, 8);
  const b0 = parseInt(p.slice(0, 2), 16);
  const b1 = parseInt(p.slice(2, 4), 16);
  const b2 = parseInt(p.slice(4, 6), 16);
  const b3 = parseInt(p.slice(6, 8), 16);
  // Frame check: the prefix must be `0000 …label… …crc… 0000`.
  if ((b0 & 0xf0) !== 0 || (b3 & 0x0f) !== 0) return undefined;
  const label = ((b0 & 0x0f) << 12) | (b1 << 4) | (b2 >> 4);
  const crc = ((b2 & 0x0f) << 4) | (b3 >> 4);
  if (crc8([(label >> 8) & 0xff, label & 0xff]) !== crc) return undefined;
  return { label, contentHex: assetNameHex.slice(8) };
}

/**
 * Build a CIP-67 asset name: the 4-byte label prefix + content (hex). The exact inverse of
 * {@link parseCip67} — `parseCip67(encodeCip67(l, c))` round-trips. Used to construct a CIP-68 (222)
 * unit for on-chain lookups (e.g. ADA Handle resolution, T8.1). `label` must fit in 16 bits and
 * `contentHex` must be even-length hex. The checksum is the same CRC-8/SMBUS over the 2 label bytes.
 */
export function encodeCip67(label: number, contentHex = ''): string {
  if (!Number.isInteger(label) || label < 0 || label > 0xffff) throw new Error('cip67: label out of 16-bit range');
  if (contentHex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(contentHex)) throw new Error('cip67: contentHex must be even-length hex');
  const crc = crc8([(label >> 8) & 0xff, label & 0xff]);
  // Inverse of the parser's bit layout: `0000 …label(16)… …crc(8)… 0000`.
  const b0 = (label >> 12) & 0x0f;
  const b1 = (label >> 4) & 0xff;
  const b2 = ((label & 0x0f) << 4) | ((crc >> 4) & 0x0f);
  const b3 = (crc & 0x0f) << 4;
  const prefix = [b0, b1, b2, b3].map((b) => b.toString(16).padStart(2, '0')).join('');
  return prefix + contentHex.toLowerCase();
}

/** Short human badge for the standard CIP-68 token classes; undefined for other/unknown labels. */
export function cip67LabelName(label: number): string | undefined {
  switch (label) {
    case 100:
      return 'ref';
    case 222:
      return 'NFT';
    case 333:
      return 'FT';
    case 444:
      return 'RFT';
    default:
      return undefined;
  }
}
