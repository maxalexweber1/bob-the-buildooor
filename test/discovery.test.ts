import { describe, it, expect } from 'vitest';
import { mnemonicToRoot, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { discoverChain, nextReceiveIndex } from '../src/background/discovery';
import type { IChainProvider } from '../src/background/provider/index';

const ZERO_24 = 'abandon '.repeat(23) + 'art';
const root = mnemonicToRoot(ZERO_24);

// External addresses for indices 0..9 (bech32 testnet, since 'preview' → testnet prefix).
const extAddr = (i: number) => baseAddress(root, 'testnet', 0, i, Role.External);

/** Minimal provider whose isUsed() is true only for a fixed set of addresses. */
function fakeProvider(usedAddresses: Set<string>): IChainProvider {
  return {
    name: 'fake',
    network: 'preview',
    isUsed: (address: string) => Promise.resolve(usedAddresses.has(address)),
    getUtxos: () => Promise.reject(new Error('not used in this test')),
    resolveUtxos: () => Promise.reject(new Error('not used')),
    getProtocolParameters: () => Promise.reject(new Error('not used')),
    getGenesisInfos: () => Promise.reject(new Error('not used')),
    submitTx: () => Promise.reject(new Error('not used')),
  };
}

describe('gap-limit discovery (T2.4)', () => {
  it('returns the contiguous used addresses and stops after the gap', async () => {
    const provider = fakeProvider(new Set([extAddr(0), extAddr(1)]));
    const used = await discoverChain(root, 'preview', Role.External, provider, 3);
    expect(used.map((u) => u.index)).toEqual([0, 1]);
  });

  it('stops before an address beyond the gap (gap of unused hides later usage)', async () => {
    // index 0 used, then 1/2/3 unused (== gapLimit 3) → discovery stops and never sees index 4.
    const provider = fakeProvider(new Set([extAddr(0), extAddr(4)]));
    const used = await discoverChain(root, 'preview', Role.External, provider, 3);
    expect(used.map((u) => u.index)).toEqual([0]);
  });

  it('finds nothing for a fresh wallet', async () => {
    const used = await discoverChain(root, 'preview', Role.External, fakeProvider(new Set()), 3);
    expect(used).toEqual([]);
  });

  it('nextReceiveIndex is one past the highest used index (0 when fresh)', () => {
    expect(nextReceiveIndex([])).toBe(0);
    expect(
      nextReceiveIndex([
        { index: 0, address: 'a', role: Role.External },
        { index: 3, address: 'b', role: Role.External },
      ]),
    ).toBe(4);
  });
});
