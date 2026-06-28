import { describe, it, expect } from 'vitest';
import { mnemonicToRoot, Role } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { discoverChain, nextReceiveIndex } from '../src/background/discovery';
import type { IChainProvider } from '../src/background/provider/index';
import { toUtxo } from '../src/background/provider/mappers';

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

const TXID = '2b8216b428b5292a4b13075cf37b26434f890a4ffcce1f75da1f85d2297efe83';

/**
 * Batched provider (the Ogmios path): exposes `getUtxosForAddresses`, returning a 1-lovelace UTxO for
 * each queried address that is "used". `isUsed`/`getUtxos` THROW — so the test also proves discovery
 * took the batched branch and never fell back to per-address probing.
 */
function fakeBatchedProvider(usedAddresses: Set<string>): IChainProvider & { calls: number } {
  const p = {
    name: 'fake-batched',
    network: 'preview' as const,
    calls: 0,
    getUtxosForAddresses(addresses: string[]) {
      p.calls++;
      const utxos = addresses
        .filter((a) => usedAddresses.has(a))
        .map((a) => toUtxo({ txHash: TXID, outputIndex: 0, address: a, amount: [{ unit: 'lovelace', quantity: '1000000' }] }));
      return Promise.resolve(utxos);
    },
    isUsed: () => Promise.reject(new Error('batched path must not call isUsed')),
    getUtxos: () => Promise.reject(new Error('batched path must not call getUtxos')),
    resolveUtxos: () => Promise.reject(new Error('not used')),
    getProtocolParameters: () => Promise.reject(new Error('not used')),
    getGenesisInfos: () => Promise.reject(new Error('not used')),
    submitTx: () => Promise.reject(new Error('not used')),
  };
  return p;
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

describe('gap-limit discovery — batched (Ogmios path)', () => {
  it('matches the per-address result and uses only the batched query', async () => {
    const provider = fakeBatchedProvider(new Set([extAddr(0), extAddr(1)]));
    const used = await discoverChain(root, 'preview', Role.External, provider, 3);
    expect(used.map((u) => u.index)).toEqual([0, 1]);
    expect(provider.calls).toBeGreaterThan(0); // proves the batched branch ran (isUsed would have thrown)
  });

  it('stops after a full window of unused addresses (gap hides later usage), same as per-address', async () => {
    // index 0 used, then 1/2/3 unused (== gapLimit 3) → never reaches index 4.
    const provider = fakeBatchedProvider(new Set([extAddr(0), extAddr(4)]));
    const used = await discoverChain(root, 'preview', Role.External, provider, 3);
    expect(used.map((u) => u.index)).toEqual([0]);
  });

  it('finds used addresses that span multiple windows', async () => {
    // 0,1 used → window resumes at 2; index 3 (< gap of 3 after 1) still found; then a clean gap.
    const provider = fakeBatchedProvider(new Set([extAddr(0), extAddr(1), extAddr(3)]));
    const used = await discoverChain(root, 'preview', Role.External, provider, 3);
    expect(used.map((u) => u.index)).toEqual([0, 1, 3]);
    expect(provider.calls).toBeGreaterThanOrEqual(2); // crossed at least one window boundary
  });

  it('finds nothing for a fresh wallet (single empty window)', async () => {
    const provider = fakeBatchedProvider(new Set());
    const used = await discoverChain(root, 'preview', Role.External, provider, 3);
    expect(used).toEqual([]);
    expect(provider.calls).toBe(1);
  });
});
