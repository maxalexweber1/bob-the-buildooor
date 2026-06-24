import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mutable state + a fake provider, hoisted so the vi.mock factories can close over them.
const h = vi.hoisted(() => {
  const state = { unlocked: true, allow: new Set<string>(), approve: true, network: 'preview' as string };
  const provider = {
    name: 'fake',
    network: 'preview',
    getUtxos: vi.fn(async () => [] as unknown[]),
    isUsed: vi.fn(async () => false),
    submitTx: vi.fn(async () => 'txhash123'),
    resolveUtxos: vi.fn(async () => []),
    getProtocolParameters: vi.fn(async () => ({})),
    getGenesisInfos: vi.fn(async () => ({})),
  };
  return { state, provider };
});

vi.mock('../src/background/vault', () => ({
  vault: { isUnlocked: async () => h.state.unlocked, getMnemonic: async () => 'abandon '.repeat(23) + 'art' },
}));
vi.mock('../src/background/settings', () => ({
  settings: { get: async () => ({ network: h.state.network, providerKind: 'blockfrost' }) },
}));
vi.mock('../src/background/autolock', () => ({ touchAutoLock: () => undefined }));
vi.mock('../src/background/discovery', () => ({ discoverChain: async () => [], nextReceiveIndex: () => 0 }));
vi.mock('../src/background/walletProvider', () => ({ getProvider: async () => h.provider }));
vi.mock('../src/background/dapp/allowlist', () => ({
  allowlist: {
    has: async (o: string) => h.state.allow.has(o),
    add: async (o: string) => void h.state.allow.add(o),
    list: async () => [...h.state.allow],
    remove: async (o: string) => void h.state.allow.delete(o),
  },
}));
vi.mock('../src/background/dapp/approvals', () => ({ requestApproval: async () => h.state.approve }));

import { handleCip30 } from '../src/background/cip30/handlers';
import { UTxO, Value, Address, defaultProtocolParameters, defaultPreviewGenesisInfos } from '@harmoniclabs/buildooor';
import { buildSend } from '../src/core/tx/build';
import { mnemonicToRoot } from '../src/core/keys';
import { baseAddress } from '../src/core/address';
import { toHex, utf8ToBytes } from '../src/core/crypto/encoding';

const ORIGIN = 'https://dapp.example';
const RECIPIENT =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';
const ownAddr = baseAddress(mnemonicToRoot('abandon '.repeat(23) + 'art'), 'testnet', 0, 0);

function aTxCbor(): string {
  const utxo = new UTxO({ utxoRef: { id: 'aa'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(10_000_000n) } });
  const tx = buildSend(
    { protocolParameters: { ...defaultProtocolParameters, utxoCostPerByte: 4310 }, genesisInfos: defaultPreviewGenesisInfos, utxos: [utxo], changeAddress: ownAddr },
    { toAddress: RECIPIENT, lovelace: 3_000_000n },
  );
  return toHex(tx.toCborBytes());
}

beforeEach(() => {
  h.state.unlocked = true;
  h.state.allow = new Set();
  h.state.approve = true;
  h.state.network = 'preview';
  h.provider.getUtxos.mockClear();
  h.provider.submitTx.mockClear();
});

describe('handleCip30 — enable & gating (T4.1)', () => {
  it('isEnabled reflects the allowlist', async () => {
    expect(await handleCip30('isEnabled', [], ORIGIN)).toBe(false);
    h.state.allow.add(ORIGIN);
    expect(await handleCip30('isEnabled', [], ORIGIN)).toBe(true);
  });

  it('enable() prompts and allowlists on approval', async () => {
    expect(await handleCip30('enable', [], ORIGIN)).toBe(true);
    expect(h.state.allow.has(ORIGIN)).toBe(true);
  });

  it('enable() declined → Refused (-3)', async () => {
    h.state.approve = false;
    await expect(handleCip30('enable', [], ORIGIN)).rejects.toMatchObject({ code: -3 });
    expect(h.state.allow.has(ORIGIN)).toBe(false);
  });

  it('a gated method on a non-enabled origin → Refused (-3)', async () => {
    await expect(handleCip30('getBalance', [], ORIGIN)).rejects.toMatchObject({ code: -3 });
  });

  it('a gated method while locked → InternalError (-2)', async () => {
    h.state.allow.add(ORIGIN);
    h.state.unlocked = false;
    await expect(handleCip30('getBalance', [], ORIGIN)).rejects.toMatchObject({ code: -2 });
  });
});

describe('handleCip30 — read methods (T4.2)', () => {
  beforeEach(() => h.state.allow.add(ORIGIN));

  it('getNetworkId: 0 testnet / 1 mainnet (no unlock needed)', async () => {
    h.state.unlocked = false;
    expect(await handleCip30('getNetworkId', [], ORIGIN)).toBe(0);
    h.state.network = 'mainnet';
    expect(await handleCip30('getNetworkId', [], ORIGIN)).toBe(1);
  });

  it('getBalance returns cbor hex (zero value for an empty wallet)', async () => {
    const hex = await handleCip30('getBalance', [], ORIGIN);
    expect(typeof hex).toBe('string');
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });

  it('getUtxos returns a hex array', async () => {
    const utxos = await handleCip30('getUtxos', [undefined, undefined], ORIGIN);
    expect(Array.isArray(utxos)).toBe(true);
  });

  it('submitTx delegates to the provider', async () => {
    expect(await handleCip30('submitTx', ['deadbeef'], ORIGIN)).toBe('txhash123');
    expect(h.provider.submitTx).toHaveBeenCalledWith('deadbeef');
  });

  it('signTx: per-call consent — declined → TxSignError UserDeclined (2)', async () => {
    h.state.approve = false;
    await expect(handleCip30('signTx', [aTxCbor(), false], ORIGIN)).rejects.toMatchObject({ code: 2 });
  });

  it('signData: address not owned by wallet → DataSignError AddressNotPK (2)', async () => {
    const foreignAddrHex = toHex(Address.fromString(RECIPIENT).toBuffer());
    await expect(
      handleCip30('signData', [foreignAddrHex, toHex(utf8ToBytes('hi'))], ORIGIN),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('cip95.getPubDRepKey returns a 32-byte hex DRep key', async () => {
    const hex = (await handleCip30('cip95.getPubDRepKey', [], ORIGIN)) as string;
    expect(hex).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
  });

  it('cip95.get{Un}registeredPubStakeKeys: stake key reported unregistered for a fresh wallet', async () => {
    expect(await handleCip30('cip95.getRegisteredPubStakeKeys', [], ORIGIN)).toEqual([]);
    const unreg = (await handleCip30('cip95.getUnregisteredPubStakeKeys', [], ORIGIN)) as string[];
    expect(unreg).toHaveLength(1);
    expect(unreg[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
