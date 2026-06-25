// Token-bundle views (T2.5 / T3.3). Pure & framework-free: convert a buildooor `Value` (or a set of
// UTxOs) into a display-friendly `{ lovelace, assets[] }`. Asset names are best-effort UTF-8 decoded
// (many CIP-25/68 tokens use ASCII); non-printable names stay hex. No chrome.*, fully unit-testable.
import type { UTxO } from '@harmoniclabs/buildooor';
import { fromHex } from './crypto/encoding';
import { parseCip67 } from './cip67';

export interface AssetBalance {
  /** policyId(56 hex) + assetName(hex). */
  unit: string;
  policyId: string;
  /** Full on-chain asset name (hex), including any CIP-67 label prefix. */
  assetNameHex: string;
  /** UTF-8 decode of the asset name (CIP-67 prefix stripped first) when printable; omitted otherwise. */
  assetNameUtf8?: string;
  /** CIP-67 label (e.g. 100 ref-NFT, 222 NFT, 333 FT, 444 RFT) when the name carries a valid prefix. */
  cip67Label?: number;
  quantity: string;
}

export interface TokenBundle {
  /** Total lovelace (1 ADA = 1_000_000 lovelace). */
  lovelace: string;
  assets: AssetBalance[];
}
/** Aggregated wallet balance (alias kept for callers). */
export type WalletBalance = TokenBundle;

/** buildooor `Value.toJson()` shape: `{ "": { "": lovelaces }, "<policyHex>": { "<assetNameHex>": qty } }`. */
type ValueJson = Record<string, Record<string, string>>;
interface HasValueJson {
  toJson(): ValueJson;
}

function accumulate(lovelaceRef: { v: bigint }, assets: Map<string, bigint>, json: ValueJson): void {
  for (const [policy, entries] of Object.entries(json)) {
    for (const [name, qty] of Object.entries(entries)) {
      if (policy === '') lovelaceRef.v += BigInt(qty);
      else {
        const unit = policy + name;
        assets.set(unit, (assets.get(unit) ?? 0n) + BigInt(qty));
      }
    }
  }
}

function finalize(lovelace: bigint, assets: Map<string, bigint>): TokenBundle {
  const list: AssetBalance[] = [...assets.entries()].map(([unit, qty]) => {
    const policyId = unit.slice(0, 56);
    const assetNameHex = unit.slice(56);
    // CIP-68 tokens carry a CIP-67 label prefix; decode the readable name from the content after it.
    const cip67 = parseCip67(assetNameHex);
    const utf8 = decodeAssetName(cip67 ? cip67.contentHex : assetNameHex);
    return {
      unit,
      policyId,
      assetNameHex,
      quantity: qty.toString(),
      ...(utf8 !== undefined ? { assetNameUtf8: utf8 } : {}),
      ...(cip67 !== undefined ? { cip67Label: cip67.label } : {}),
    };
  });
  return { lovelace: lovelace.toString(), assets: list };
}

/** One buildooor `Value` → token bundle. */
export function valueView(value: HasValueJson): TokenBundle {
  const lovelace = { v: 0n };
  const assets = new Map<string, bigint>();
  accumulate(lovelace, assets, value.toJson());
  return finalize(lovelace.v, assets);
}

/** Sum a set of UTxOs → total token bundle. */
export function aggregateBalance(utxos: UTxO[]): TokenBundle {
  const lovelace = { v: 0n };
  const assets = new Map<string, bigint>();
  for (const u of utxos) accumulate(lovelace, assets, (u.resolved.value as HasValueJson).toJson());
  return finalize(lovelace.v, assets);
}

/** UTF-8 decode an asset name iff it's non-empty printable ASCII; otherwise undefined (keep hex). */
export function decodeAssetName(hex: string): string | undefined {
  if (!hex) return undefined;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(fromHex(hex));
    return s.length > 0 && /^[\x20-\x7e]+$/.test(s) ? s : undefined;
  } catch {
    return undefined;
  }
}
