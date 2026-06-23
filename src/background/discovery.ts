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
  const used: DiscoveredAddress[] = [];
  let consecutiveUnused = 0;

  for (let index = 0; index < MAX_SCAN && consecutiveUnused < gapLimit; index++) {
    const address = baseAddressFrom(keys, bech32, index, role);
    if (await provider.isUsed(address)) {
      used.push({ index, address, role });
      consecutiveUnused = 0;
    } else {
      consecutiveUnused++;
    }
  }
  return used;
}

/** Next external receive address index: one past the highest used external index (0 for a fresh wallet). */
export function nextReceiveIndex(usedExternal: DiscoveredAddress[]): number {
  return usedExternal.reduce((max, a) => Math.max(max, a.index + 1), 0);
}

export { Role };
