// Gap-limit address discovery (EXECUTION_PLAN T2.4). CIP-1852 wallets don't get a from-the-chain
// address list — we walk a derivation chain (external role 0 / change role 1), probing each address's
// on-chain usage, and stop after `GAP_LIMIT` consecutive unused (the BIP-44/CIP-1852 de-facto 20).
import type { XPrv } from '@harmoniclabs/buildooor';
import { accountKeys, baseAddressFrom, bech32Network, type PaymentRole } from '../core/address';
import { Role } from '../core/keys';
import type { IChainProvider, Network } from './provider/index';

export const GAP_LIMIT = 20;
/** Hard cap so a misbehaving provider (always-"used") can't loop forever. */
const MAX_SCAN = 200;

export interface DiscoveredAddress {
  index: number;
  address: string;
  role: PaymentRole;
}

/** Address factory for one payment chain: derivation `index` → bech32 address. */
export type AddressAt = (index: number) => string;

/**
 * Generic gap-limit walk over any address chain (hot wallet via XPrv, hardware account via xpub —
 * T6.3). Walks `addressAt(0..)` until `gapLimit` consecutive unused; returns the used ones.
 */
export async function discoverAddresses(
  addressAt: AddressAt,
  role: PaymentRole,
  provider: IChainProvider,
  gapLimit: number = GAP_LIMIT,
): Promise<DiscoveredAddress[]> {
  // Providers without an address index (Ogmios) scan the whole ledger UTxO set per by-address query,
  // so probing 40 addresses one-at-a-time times out. When the provider exposes a batched lookup, walk
  // a gap-limit WINDOW per round-trip instead (one full-set scan covers the whole window).
  if (provider.getUtxosForAddresses) return discoverAddressesBatched(addressAt, role, provider, gapLimit);

  const used: DiscoveredAddress[] = [];
  let consecutiveUnused = 0;

  for (let index = 0; index < MAX_SCAN && consecutiveUnused < gapLimit; index++) {
    const address = addressAt(index);
    if (await provider.isUsed(address)) {
      used.push({ index, address, role });
      consecutiveUnused = 0;
    } else {
      consecutiveUnused++;
    }
  }
  return used;
}

/** Walk one payment chain (role) until GAP_LIMIT consecutive unused addresses; return the used ones. */
export async function discoverChain(
  root: XPrv,
  network: Network,
  role: PaymentRole,
  provider: IChainProvider,
  gapLimit: number = GAP_LIMIT,
): Promise<DiscoveredAddress[]> {
  const bech32 = bech32Network(network);
  const keys = accountKeys(root, 0); // derive account + stake once; cheap per-address below
  return discoverAddresses((index) => baseAddressFrom(keys, bech32, index, role), role, provider, gapLimit);
}

/**
 * Batched gap-limit discovery for index-less providers (Ogmios). Queries a window of `gapLimit`
 * addresses in ONE `getUtxosForAddresses` call; "used" = the address appears in the returned UTxOs
 * (same current-UTxO approximation as `isUsed` on Ogmios — see its note). A window with zero used
 * addresses means `gapLimit` consecutive unused → stop; otherwise resume one past the last used index.
 * Worst case ~one scan per used cluster + a trailing empty window, vs. one scan per address before.
 */
async function discoverAddressesBatched(
  addressAt: AddressAt,
  role: PaymentRole,
  provider: IChainProvider,
  gapLimit: number,
): Promise<DiscoveredAddress[]> {
  const lookup = provider.getUtxosForAddresses;
  if (!lookup) return []; // unreachable (guarded by the caller); satisfies the type narrowing
  const used: DiscoveredAddress[] = [];

  for (let start = 0; start < MAX_SCAN; ) {
    const end = Math.min(start + gapLimit, MAX_SCAN);
    const window: DiscoveredAddress[] = [];
    for (let index = start; index < end; index++) {
      window.push({ index, address: addressAt(index), role });
    }
    const utxos = await lookup.call(provider, window.map((w) => w.address));
    const usedAddrs = new Set<string>(utxos.map((u) => u.resolved.address.toString()));
    const windowUsed = window.filter((w) => usedAddrs.has(w.address));
    const last = windowUsed[windowUsed.length - 1];
    if (!last) break; // whole window unused → gap limit reached
    used.push(...windowUsed);
    start = last.index + 1;
  }
  return used;
}

/** Next external receive address index: one past the highest used external index (0 for a fresh wallet). */
export function nextReceiveIndex(usedExternal: DiscoveredAddress[]): number {
  return usedExternal.reduce((max, a) => Math.max(max, a.index + 1), 0);
}

export { Role };
