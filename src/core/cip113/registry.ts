// CIP-113 on-chain registry client (EXECUTION_PLAN T9.1). The registry is a sorted linked list of
// RegistryNode UTxOs at a fixed address; a native token is programmable iff a node with
// `key == policy_id` exists. Each node carries the credentials of the token's transfer-logic
// validators — the data a (future, T9.4) transfer builder needs.
//
// Reference: cardano-foundation/cip113-programmable-tokens documentation 02-ARCHITECTURE /
// 08-INTEGRATION-GUIDES. Upstream is R&D-grade — the datum layout below matches its documented shape
// and the decoder is deliberately tolerant (unknown shapes → null, never a throw on chain data).
//
// Security:
//  - NFT = AUTHENTICITY. The registry address is public — anyone can park a UTxO there with a forged
//    datum claiming arbitrary transfer logic. A node counts ONLY if its UTxO holds a token under the
//    registry-node policy whose asset name equals the datum's `key` (the upstream invariant). Datum
//    alone is never trusted.
//  - NEVER cache node UTxO refs across builds (upstream-documented pitfall: nodes are spent and
//    re-created on registry updates; a stale ref validates against the wrong logic or fails). This
//    module resolves fresh per call; only a short-TTL boolean "is programmable" DISPLAY cache is
//    acceptable at the caller.
//
// Framework-free; the chain read is injected as a minimal structural lookup (same decoupling as
// core/handle.ts) so this stays reusable from SW + popup and trivially unit-testable.
import type { UTxO } from '@harmoniclabs/buildooor';
import { DataB, DataConstr, DataList } from '@harmoniclabs/buildooor';
import { toHex } from '../crypto/encoding';
import type { Cip113Params } from './params';

/** A Plutus `Credential`: constr 0 = verification-key hash, constr 1 = script hash (28 bytes hex). */
export interface Cip113Credential {
  type: 'key' | 'script';
  hash: string;
}

/** Decoded RegistryNode datum (upstream field order; `key === ''` is the list's origin node). */
export interface RegistryNode {
  /** Policy id this node registers ('' for the origin node). */
  key: string;
  /** Successor policy id in the sorted list ('' at the tail). */
  next: string;
  mintingLogicScript: Cip113Credential;
  transferLogicScript: Cip113Credential;
  thirdPartyTransferLogicScript: Cip113Credential;
  /** Optional global-state NFT currency symbol (hex, may be ''). */
  globalStateCs?: string;
  /** Protected CIP-67 label prefixes (hex), when present. */
  protectedPrefixes?: string[];
}

/** A registry node together with the UTxO it currently lives in (resolve fresh — do not persist). */
export interface RegistryNodeRef {
  node: RegistryNode;
  utxoRef: { txHash: string; index: number };
  /** The full node UTxO — needed as a reference input by the transfer builder (T9.4). */
  utxo?: UTxO;
}

/** The one chain capability the registry client needs: UTxOs (with inline datums) at an address. */
export interface RegistryLookup {
  getUtxos(address: string): Promise<UTxO[]>;
}

const POLICY_RE = /^[0-9a-f]{56}$/;

/** DataB → hex, tolerating buildooor's ByteString wrapper. Null when it isn't a byte string. */
function bytesHex(d: unknown): string | null {
  if (!(d instanceof DataB)) return null;
  const b = d.bytes as unknown as { toBuffer?: () => Uint8Array } | Uint8Array;
  if (b instanceof Uint8Array) return toHex(b);
  return b.toBuffer ? toHex(b.toBuffer()) : null;
}

/** Plutus Credential datum → typed credential. Constr 0 = key hash, 1 = script hash; else null. */
function credentialFrom(d: unknown): Cip113Credential | null {
  if (!(d instanceof DataConstr)) return null;
  const idx = Number(d.constr);
  if (idx !== 0 && idx !== 1) return null;
  if (d.fields.length < 1) return null;
  const hash = bytesHex(d.fields[0]);
  if (hash === null || !POLICY_RE.test(hash)) return null;
  return { type: idx === 0 ? 'key' : 'script', hash };
}

/**
 * Decode a RegistryNode datum. Tolerant: anything that doesn't match the documented shape returns
 * null (chain data is untrusted input — a malformed datum must never break a balance refresh).
 * Fields 0–4 (key, next, minting/transfer/third-party logic) are required; 5–6 are optional so a
 * compatible upstream extension doesn't invalidate existing nodes.
 */
export function decodeRegistryNode(datum: unknown): RegistryNode | null {
  if (!(datum instanceof DataConstr) || Number(datum.constr) !== 0) return null;
  const f = datum.fields;
  if (f.length < 5) return null;

  const key = bytesHex(f[0]);
  const next = bytesHex(f[1]);
  // key/next are policy ids; '' marks the origin/tail sentinel of the sorted list.
  if (key === null || !(key === '' || POLICY_RE.test(key))) return null;
  if (next === null || !(next === '' || POLICY_RE.test(next))) return null;

  const mintingLogicScript = credentialFrom(f[2]);
  const transferLogicScript = credentialFrom(f[3]);
  const thirdPartyTransferLogicScript = credentialFrom(f[4]);
  if (!mintingLogicScript || !transferLogicScript || !thirdPartyTransferLogicScript) return null;

  const globalStateCs = f.length > 5 ? bytesHex(f[5]) : null;
  const protectedPrefixes =
    f.length > 6 && f[6] instanceof DataList
      ? (f[6] as DataList).list.map(bytesHex).filter((x): x is string => x !== null)
      : null;

  return {
    key,
    next,
    mintingLogicScript,
    transferLogicScript,
    thirdPartyTransferLogicScript,
    ...(globalStateCs !== null ? { globalStateCs } : {}),
    ...(protectedPrefixes !== null ? { protectedPrefixes } : {}),
  };
}

/** buildooor `Value.toJson()` shape (mirrors core/balance.ts). */
type ValueJson = Record<string, Record<string, string>>;

/** Does this UTxO hold the registry NFT authenticating a node with datum-`key`? (name == key.) */
function holdsRegistryNft(utxo: UTxO, registryNodePolicyId: string, key: string): boolean {
  const value = (utxo.resolved.value as unknown as { toJson(): ValueJson }).toJson();
  const underPolicy = value[registryNodePolicyId];
  if (!underPolicy) return false;
  const qty = underPolicy[key];
  return qty !== undefined && BigInt(qty) > 0n;
}

/**
 * Find the registry node for `policyId` — i.e. "is this token programmable, and under which transfer
 * logic?". Scans the registry address's UTxOs, keeps only NFT-authenticated nodes, and matches on the
 * datum key. Returns null when the policy isn't registered (a plain native asset) or when `policyId`
 * is malformed. Resolves FRESH every call by design (see header); do not persist the returned utxoRef.
 */
export async function findRegistryNode(
  policyId: string,
  params: Cip113Params,
  lookup: RegistryLookup,
): Promise<RegistryNodeRef | null> {
  const wanted = policyId.toLowerCase();
  if (!POLICY_RE.test(wanted)) return null;

  const utxos = await lookup.getUtxos(params.registryAddress);
  for (const u of utxos) {
    const node = decodeRegistryNode(u.resolved.datum);
    if (!node || node.key !== wanted) continue;
    if (!holdsRegistryNft(u, params.registryNodePolicyId, node.key)) continue; // forged datum — skip
    return { node, utxoRef: { txHash: u.utxoRef.id.toString(), index: u.utxoRef.index }, utxo: u };
  }
  return null;
}

/** Convenience: is `policyId` a registered CIP-113 programmable token? */
export async function isProgrammablePolicy(
  policyId: string,
  params: Cip113Params,
  lookup: RegistryLookup,
): Promise<boolean> {
  return (await findRegistryNode(policyId, params, lookup)) !== null;
}
