import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mutable state + a fake provider, hoisted so the vi.mock factories can close over them.
const h = vi.hoisted(() => {
  const state = {
    unlocked: true,
    allow: new Set<string>(),
    ext: new Map<string, number[]>(),
    approve: true,
    network: 'preview' as string,
  };
  const provider = {
    name: 'fake',
    network: 'preview',
    getUtxos: vi.fn(async () => [] as unknown[]),
    isUsed: vi.fn(async () => false),
    submitTx: vi.fn(async () => 'txhash123'),
    resolveUtxos: vi.fn(async () => []),
    getStakeRegistration: vi.fn(async () => false),
    getProtocolParameters: vi.fn(async () => ({})),
    getGenesisInfos: vi.fn(async () => ({})),
    getAssetAddresses: vi.fn(async () => [] as Array<{ address: string; quantity: string }>),
  };
  // Counting mock so the discovery-cache tests can assert how many walks actually ran.
  const discoverChain = vi.fn(async () => [] as unknown[]);
  // Two-phase approval mocks (signTx opens the window first, then delivers the decoded summary).
  const openApproval = vi.fn(async () => ({ reqId: 'req-test', decision: Promise.resolve(state.approve) }));
  const setApprovalPayload = vi.fn(async () => undefined);
  const cancelApproval = vi.fn(async () => undefined);
  return { state, provider, discoverChain, openApproval, setApprovalPayload, cancelApproval };
});

vi.mock('../src/background/vault', () => ({
  vault: { isUnlocked: async () => h.state.unlocked, getMnemonic: async () => 'abandon '.repeat(23) + 'art' },
}));
vi.mock('../src/background/settings', () => ({
  settings: { get: async () => ({ network: h.state.network, providerKind: 'blockfrost' }) },
}));
vi.mock('../src/background/autolock', () => ({ touchAutoLock: () => undefined }));
vi.mock('../src/background/discovery', () => ({ discoverChain: h.discoverChain, nextReceiveIndex: () => 0 }));
vi.mock('../src/background/walletProvider', () => ({ getProvider: async () => h.provider }));
vi.mock('../src/background/dapp/allowlist', () => ({
  allowlist: {
    has: async (o: string) => h.state.allow.has(o),
    add: async (o: string, ext: number[] = []) => {
      h.state.allow.add(o);
      h.state.ext.set(o, ext);
    },
    getExtensions: async (o: string) => h.state.ext.get(o) ?? [],
    list: async () => [...h.state.allow],
    remove: async (o: string) => {
      h.state.allow.delete(o);
      h.state.ext.delete(o);
    },
  },
}));
vi.mock('../src/background/dapp/approvals', () => ({
  requestApproval: async () => h.state.approve,
  openApproval: h.openApproval,
  setApprovalPayload: h.setApprovalPayload,
  cancelApproval: h.cancelApproval,
}));

import { handleCip30, clearCip30DiscoveryCache } from '../src/background/cip30/handlers';
import {
  UTxO,
  Value,
  Address,
  Tx,
  TxBody,
  TxOut,
  TxWitnessSet,
  CertVoteDeleg,
  Credential,
  DRepAlwaysAbstain,
  TxBuilder,
  defaultProtocolParameters,
  defaultPreviewGenesisInfos,
} from '@harmoniclabs/buildooor';
import { buildSend } from '../src/core/tx/build';
import { mnemonicToRoot } from '../src/core/keys';
import { baseAddress, accountKeys, drepPublicKey, keyHash28, rewardAddress, stakePublicKey } from '../src/core/address';
import { verifyCoseSign1 } from '../src/core/cose/verify';
import { toHex, utf8ToBytes } from '../src/core/crypto/encoding';
import { ProviderHttpError, ProviderTimeoutError } from '../src/background/provider/IChainProvider';
import type { Cip30Error } from '../src/shared/errors';
import type { BulkSignApprovalPayload } from '../src/shared/internal';

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
  h.state.ext = new Map();
  h.state.approve = true;
  h.state.network = 'preview';
  clearCip30DiscoveryCache(); // the cache is a module global — isolate tests from each other
  h.discoverChain.mockClear();
  h.discoverChain.mockResolvedValue([]);
  h.openApproval.mockClear();
  h.setApprovalPayload.mockClear();
  h.cancelApproval.mockClear();
  h.provider.getUtxos.mockClear();
  h.provider.submitTx.mockClear();
  h.provider.getAssetAddresses.mockClear();
  h.provider.getAssetAddresses.mockResolvedValue([]);
  h.provider.getStakeRegistration.mockClear();
  h.provider.getStakeRegistration.mockResolvedValue(false);
});

describe('handleCip30 — enable & gating (T4.1)', () => {
  it('isEnabled reflects the allowlist', async () => {
    expect(await handleCip30('isEnabled', [], ORIGIN)).toBe(false);
    h.state.allow.add(ORIGIN);
    expect(await handleCip30('isEnabled', [], ORIGIN)).toBe(true);
  });

  it('enable() prompts and allowlists on approval (no extensions → empty grant)', async () => {
    expect(await handleCip30('enable', [], ORIGIN)).toEqual([]);
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

describe('handleCip30 — getExtensions & extension negotiation (T4.6)', () => {
  it('enable({extensions:[{cip:95}]}) grants it; getExtensions reports the granted set', async () => {
    expect(await handleCip30('enable', [[{ cip: 95 }]], ORIGIN)).toEqual([{ cip: 95 }]);
    expect(await handleCip30('getExtensions', [], ORIGIN)).toEqual([{ cip: 95 }]);
  });

  it('enable() with no extensions → getExtensions reports none', async () => {
    await handleCip30('enable', [], ORIGIN);
    expect(await handleCip30('getExtensions', [], ORIGIN)).toEqual([]);
  });

  it('an unsupported requested extension is not granted', async () => {
    expect(await handleCip30('enable', [[{ cip: 999 }]], ORIGIN)).toEqual([]);
    expect(await handleCip30('getExtensions', [], ORIGIN)).toEqual([]);
  });

  it('a malformed extensions argument is ignored, not fatal', async () => {
    expect(await handleCip30('enable', ['not-an-array'], ORIGIN)).toEqual([]);
    expect(h.state.allow.has(ORIGIN)).toBe(true);
  });

  it('getExtensions needs no unlock', async () => {
    h.state.allow.add(ORIGIN);
    h.state.ext.set(ORIGIN, [95]);
    h.state.unlocked = false;
    expect(await handleCip30('getExtensions', [], ORIGIN)).toEqual([{ cip: 95 }]);
  });

  it('getExtensions on a non-enabled origin → Refused (-3)', async () => {
    await expect(handleCip30('getExtensions', [], ORIGIN)).rejects.toMatchObject({ code: -3 });
  });

  it('a cip95.* method is rejected (InvalidRequest -1) if cip95 was not negotiated (raw-message bypass)', async () => {
    // Origin is enabled but did NOT negotiate cip95 — a hostile page crafting a raw cip95 message
    // must not reach the governance handler (T4.7 gate).
    h.state.allow.add(ORIGIN); // enabled, but h.state.ext has no entry → no extensions
    await expect(handleCip30('cip95.getPubDRepKey', [], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('the same cip95.* method succeeds once cip95 IS negotiated', async () => {
    h.state.allow.add(ORIGIN);
    h.state.ext.set(ORIGIN, [95]);
    const hex = (await handleCip30('cip95.getPubDRepKey', [], ORIGIN)) as string;
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('handleCip30 — read methods (T4.2)', () => {
  beforeEach(() => {
    h.state.allow.add(ORIGIN);
    h.state.ext.set(ORIGIN, [95]); // cip95 negotiated (gates the cip95.* methods below — T4.7)
  });

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

  it('submitTx provider failure → GENERIC dApp-facing error, never the raw provider message', async () => {
    h.provider.submitTx.mockRejectedValueOnce(
      new ProviderHttpError(500, 'HTTP 500 for https://user:secret@example.com/api?token=abc: upstream body'),
    );
    const err = (await handleCip30('submitTx', ['deadbeef'], ORIGIN).catch((e: unknown) => e)) as Cip30Error;
    expect(err).toMatchObject({ code: 2, info: 'provider rejected transaction' });

    h.provider.submitTx.mockRejectedValueOnce(new ProviderTimeoutError('request to https://x/api timed out'));
    const err2 = (await handleCip30('submitTx', ['deadbeef'], ORIGIN).catch((e: unknown) => e)) as Cip30Error;
    expect(err2).toMatchObject({ code: 2, info: 'provider timed out' });

    h.provider.submitTx.mockRejectedValueOnce(new Error('anything else with http://user:pw@host details'));
    const err3 = (await handleCip30('submitTx', ['deadbeef'], ORIGIN).catch((e: unknown) => e)) as Cip30Error;
    expect(err3).toMatchObject({ code: 2, info: 'submit failed' });
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
    // Open-first flow: the prompt opened immediately (payload is known up-front) and was cancelled
    // once the concurrent ownership check failed.
    expect(h.openApproval).toHaveBeenCalled();
    expect(h.cancelApproval).toHaveBeenCalledWith('req-test');
  });

  it('signData: malformed input never opens a prompt', async () => {
    await expect(handleCip30('signData', [ownAddr, 'zz'], ORIGIN)).rejects.toMatchObject({ code: -1 });
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it('signData accepts the same owned address as bech32 and as hex (bech32-or-hex rule)', async () => {
    const payload = toHex(utf8ToBytes('hello'));
    const viaBech32 = (await handleCip30('signData', [ownAddr, payload], ORIGIN)) as { signature: string; key: string };
    const viaHex = (await handleCip30('signData', [toHex(Address.fromString(ownAddr).toBuffer()), payload], ORIGIN)) as { signature: string; key: string };
    // Ed25519 is deterministic: identical key + payload + address header ⇒ identical COSE output.
    expect(viaBech32.signature).toBe(viaHex.signature);
    expect(viaBech32.key).toBe(viaHex.key);
  });

  it('signData: malformed payload hex → InvalidRequest (-1), never coerced and signed', async () => {
    await expect(handleCip30('signData', [ownAddr, 'zz'], ORIGIN)).rejects.toMatchObject({ code: -1 });
    await expect(handleCip30('signData', [ownAddr, 'abc'], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('signData: malformed address input → InvalidRequest (-1)', async () => {
    await expect(handleCip30('signData', ['not-an-address', '00'], ORIGIN)).rejects.toMatchObject({ code: -1 });
    await expect(handleCip30('signData', [42 as unknown as string, '00'], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('cip95.getPubDRepKey returns a 32-byte hex DRep key', async () => {
    const hex = (await handleCip30('cip95.getPubDRepKey', [], ORIGIN)) as string;
    expect(hex).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
  });

  it('cip95.get{Un}registeredPubStakeKeys: unregistered stake key reported via the UNregistered call', async () => {
    expect(await handleCip30('cip95.getRegisteredPubStakeKeys', [], ORIGIN)).toEqual([]);
    const unreg = (await handleCip30('cip95.getUnregisteredPubStakeKeys', [], ORIGIN)) as string[];
    expect(unreg).toHaveLength(1);
    expect(unreg[0]).toMatch(/^[0-9a-f]{64}$/);
    // The provider was asked about the wallet's bech32 reward address.
    const keys = accountKeys(mnemonicToRoot('abandon '.repeat(23) + 'art'), 0);
    expect(h.provider.getStakeRegistration).toHaveBeenCalledWith(rewardAddress(keys, 'testnet').toString());
  });

  it('cip95.get{Un}registeredPubStakeKeys: REGISTERED stake key moves to the registered call (T6.1)', async () => {
    h.provider.getStakeRegistration.mockResolvedValue(true);
    const reg = (await handleCip30('cip95.getRegisteredPubStakeKeys', [], ORIGIN)) as string[];
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(await handleCip30('cip95.getUnregisteredPubStakeKeys', [], ORIGIN)).toEqual([]);
  });

  it('cip95.get{Un}registeredPubStakeKeys: provider failure degrades to unregistered, never throws', async () => {
    h.provider.getStakeRegistration.mockRejectedValue(new Error('node down'));
    expect(await handleCip30('cip95.getRegisteredPubStakeKeys', [], ORIGIN)).toEqual([]);
    expect((await handleCip30('cip95.getUnregisteredPubStakeKeys', [], ORIGIN)) as string[]).toHaveLength(1);
  });
});

describe('handleCip30 — cip95.signData (T6.1, DRep/stake-key COSE)', () => {
  const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
  const keys = accountKeys(root, 0);
  const drepIdHex = toHex(keyHash28(drepPublicKey(keys)));
  const stakeAddrBech32 = rewardAddress(keys, 'testnet').toString();
  const payload = toHex(utf8ToBytes('DRep vote authorisation'));

  beforeEach(() => {
    h.state.allow.add(ORIGIN);
    h.state.ext.set(ORIGIN, [95]);
  });

  it("signs with the DRep key for the wallet's own DRep ID (hex, with and without 0x)", async () => {
    const out = (await handleCip30('cip95.signData', [drepIdHex, payload], ORIGIN)) as { signature: string; key: string };
    // COSE verifies AND the COSE_Key carries the DRep public key (not a payment/stake key).
    const v = verifyCoseSign1(out.signature, out.key);
    expect(v.valid).toBe(true);
    expect(v.payloadUtf8).toBe('DRep vote authorisation');
    expect(out.key).toContain(toHex(drepPublicKey(keys)));
    const viaPrefixed = (await handleCip30('cip95.signData', [`0x${drepIdHex}`, payload], ORIGIN)) as { signature: string };
    expect(viaPrefixed.signature).toBe(out.signature); // deterministic Ed25519, same input
  });

  it("signs with the STAKE key for the wallet's own reward address (bech32 and hex form)", async () => {
    const out = (await handleCip30('cip95.signData', [stakeAddrBech32, payload], ORIGIN)) as { signature: string; key: string };
    expect(verifyCoseSign1(out.signature, out.key).valid).toBe(true);
    expect(out.key).toContain(toHex(stakePublicKey(keys)));
    const hexForm = toHex(rewardAddress(keys, 'testnet').toBuffer());
    const out2 = (await handleCip30('cip95.signData', [hexForm, payload], ORIGIN)) as { signature: string };
    expect(out2.signature).toBe(out.signature);
  });

  it("a foreign DRep ID → ProofGeneration (1) — wallet doesn't hold that key", async () => {
    await expect(handleCip30('cip95.signData', ['ff'.repeat(28), payload], ORIGIN)).rejects.toMatchObject({ code: 1 });
  });

  it('a foreign stake address → ProofGeneration (1); a script reward address → AddressNotPK (2)', async () => {
    const foreignStakeHex = 'e1' + 'ab'.repeat(28);
    await expect(handleCip30('cip95.signData', [foreignStakeHex, payload], ORIGIN)).rejects.toMatchObject({ code: 1 });
    const scriptStakeHex = 'f1' + 'ab'.repeat(28);
    await expect(handleCip30('cip95.signData', [scriptStakeHex, payload], ORIGIN)).rejects.toMatchObject({ code: 2 });
  });

  it('malformed payload or input → InvalidRequest (-1)', async () => {
    await expect(handleCip30('cip95.signData', [drepIdHex, 'zz'], ORIGIN)).rejects.toMatchObject({ code: -1 });
    await expect(handleCip30('cip95.signData', [42 as unknown as string, payload], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('user decline → DataSignError UserDeclined (3)', async () => {
    h.state.approve = false;
    await expect(handleCip30('cip95.signData', [drepIdHex, payload], ORIGIN)).rejects.toMatchObject({ code: 3 });
  });

  it('a payment address falls through to the plain CIP-30 signData semantics', async () => {
    const out = (await handleCip30('cip95.signData', [ownAddr, payload], ORIGIN)) as { signature: string; key: string };
    expect(verifyCoseSign1(out.signature, out.key).valid).toBe(true);
    // and a foreign payment address still maps to AddressNotPK (2)
    await expect(handleCip30('cip95.signData', [RECIPIENT, payload], ORIGIN)).rejects.toMatchObject({ code: 2 });
  });

  it('raw-postMessage cip95.signData WITHOUT negotiation is still blocked (InvalidRequest -1)', async () => {
    h.state.ext.set(ORIGIN, []); // enabled origin, but cip95 not negotiated
    await expect(handleCip30('cip95.signData', [drepIdHex, payload], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });
});

describe('handleCip30 — signTx collateral & required-signer witnessing', () => {
  const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
  const ownPaymentKeyHash = Address.fromString(ownAddr).paymentCreds.hash.toString();
  const ownStakeKeyHash = toHex(accountKeys(root, 0).stakeKeyHash);

  beforeEach(() => {
    h.state.allow.add(ORIGIN);
    h.provider.resolveUtxos.mockClear();
  });

  function rawTxHex(body: Omit<ConstructorParameters<typeof TxBody>[0], 'outputs'>): string {
    const outputs = [new TxOut({ address: Address.fromString(RECIPIENT), value: Value.lovelaces(9_800_000n) })];
    return toHex(new Tx({ body: new TxBody({ ...body, outputs }), witnesses: new TxWitnessSet({}) }).toCborBytes());
  }

  const foreignSpend = () =>
    new UTxO({ utxoRef: { id: 'aa'.repeat(32), index: 0 }, resolved: { address: RECIPIENT, value: Value.lovelaces(10_000_000n) } });

  it('a wallet-owned collateral input yields the payment witness even with no wallet spending input', async () => {
    const spend = foreignSpend();
    const coll = new UTxO({ utxoRef: { id: 'bb'.repeat(32), index: 0 }, resolved: { address: ownAddr, value: Value.lovelaces(5_000_000n) } });
    h.provider.resolveUtxos.mockResolvedValueOnce([spend, coll]);
    const witHex = (await handleCip30(
      'signTx',
      [rawTxHex({ inputs: [spend], outputs: [], fee: 200_000n, collateralInputs: [coll] }), false],
      ORIGIN,
    )) as string;
    const wits = TxWitnessSet.fromCbor(witHex);
    expect(wits.vkeyWitnesses).toHaveLength(1);
    expect(wits.vkeyWitnesses?.[0]?.vkey.hash.toString()).toBe(ownPaymentKeyHash);
    // the collateral ref must be resolved too (it feeds the approval display + witness selection)
    expect(h.provider.resolveUtxos.mock.calls.at(-1)?.[0]).toHaveLength(2);
  });

  it('a tx whose ONLY wallet link is a requiredSigner payment-key hash still gets a witness', async () => {
    const spend = foreignSpend();
    h.provider.resolveUtxos.mockResolvedValueOnce([spend]);
    const witHex = (await handleCip30(
      'signTx',
      [rawTxHex({ inputs: [spend], outputs: [], fee: 200_000n, requiredSigners: [ownPaymentKeyHash] }), false],
      ORIGIN,
    )) as string;
    const wits = TxWitnessSet.fromCbor(witHex);
    expect(wits.vkeyWitnesses).toHaveLength(1);
    expect(wits.vkeyWitnesses?.[0]?.vkey.hash.toString()).toBe(ownPaymentKeyHash);
  });

  it('a wallet-owned STAKE-key requiredSigner is witnessed with the stake key', async () => {
    const spend = foreignSpend();
    h.provider.resolveUtxos.mockResolvedValueOnce([spend]);
    const witHex = (await handleCip30(
      'signTx',
      [rawTxHex({ inputs: [spend], outputs: [], fee: 200_000n, requiredSigners: [ownStakeKeyHash] }), false],
      ORIGIN,
    )) as string;
    const wits = TxWitnessSet.fromCbor(witHex);
    expect(wits.vkeyWitnesses).toHaveLength(1);
    expect(wits.vkeyWitnesses?.[0]?.vkey.hash.toString()).toBe(ownStakeKeyHash);
  });

  it('a Conway vote-delegation cert is witnessed with the STAKE key — and NEVER the DRep key (T6.2)', async () => {
    // ledger-ts 0.5.6's signWith signs with every offered key, so the wallet must curate: a
    // vote-delegation requires payment (input owner) + stake (cert authorizer) — offering the DRep
    // key too would leak a gratuitous DRep signature on-chain (pinned by the preview proof tx
    // 35806f03…; this test keeps the selection honest offline).
    const ownSpend = new UTxO({
      utxoRef: { id: 'cc'.repeat(32), index: 0 },
      resolved: { address: ownAddr, value: Value.lovelaces(10_000_000n) },
    });
    h.provider.resolveUtxos.mockResolvedValueOnce([ownSpend]);
    // Built via TxBuilder (not a raw TxBody): the plain TxBody constructor still validates certs
    // against a divergent class copy and rejects the exported CertVoteDeleg — the builder path is
    // what real dApps use and what the on-chain proof exercised.
    const tb = new TxBuilder(
      { ...defaultProtocolParameters, utxoCostPerByte: 4310 },
      defaultPreviewGenesisInfos,
    );
    const voteTx = tb.buildSync({
      inputs: [{ utxo: ownSpend }],
      certificates: [
        {
          cert: new CertVoteDeleg({
            stakeCredential: Credential.keyHash(accountKeys(root, 0).stakeKeyHash),
            drep: new DRepAlwaysAbstain({}),
          }),
        },
      ],
      changeAddress: ownAddr,
    });
    const witHex = (await handleCip30('signTx', [toHex(voteTx.toCborBytes()), false], ORIGIN)) as string;
    const hashes = (TxWitnessSet.fromCbor(witHex).vkeyWitnesses ?? []).map((w) => w.vkey.hash.toString());
    expect(hashes).toHaveLength(2);
    expect(hashes).toContain(ownPaymentKeyHash);
    expect(hashes).toContain(ownStakeKeyHash);
  });

  it('foreign inputs, foreign collateral and a foreign requiredSigner → ProofGeneration (1), no witness', async () => {
    const spend = foreignSpend();
    const coll = new UTxO({ utxoRef: { id: 'bb'.repeat(32), index: 1 }, resolved: { address: RECIPIENT, value: Value.lovelaces(5_000_000n) } });
    h.provider.resolveUtxos.mockResolvedValueOnce([spend, coll]);
    await expect(
      handleCip30(
        'signTx',
        [rawTxHex({ inputs: [spend], outputs: [], fee: 200_000n, collateralInputs: [coll], requiredSigners: ['ff'.repeat(28)] }), false],
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: 1 });
  });
});

describe('handleCip30 — signTx two-phase approval (instant window + spinner)', () => {
  beforeEach(() => {
    h.state.allow.add(ORIGIN);
    h.provider.resolveUtxos.mockClear();
    h.provider.resolveUtxos.mockResolvedValue([]);
  });

  it('opens the window payload-PENDING, then delivers the decoded summary (decode-before-sign)', async () => {
    // partialSign — the wallet owning none of the inputs is acceptable for this flow test
    await handleCip30('signTx', [aTxCbor(), true], ORIGIN);
    expect(h.openApproval).toHaveBeenCalledWith('signTx', ORIGIN, undefined, { payloadPending: true });
    const call = h.setApprovalPayload.mock.calls[0] as unknown[] | undefined;
    expect(call?.[0]).toBe('req-test');
    expect(call?.[1]).toHaveProperty('outputs'); // a real TxSummary, not a raw CBOR blob
    expect(h.cancelApproval).not.toHaveBeenCalled();
  });

  it('chain-work failure closes the prompt (cancelApproval) and surfaces the error to the dApp', async () => {
    h.provider.resolveUtxos.mockRejectedValueOnce(new Error('resolve failed'));
    await expect(handleCip30('signTx', [aTxCbor(), false], ORIGIN)).rejects.toThrow('resolve failed');
    expect(h.cancelApproval).toHaveBeenCalledWith('req-test');
    expect(h.setApprovalPayload).not.toHaveBeenCalled();
  });

  it('malformed tx CBOR fails BEFORE any window opens', async () => {
    await expect(handleCip30('signTx', ['zz-not-cbor', false], ORIGIN)).rejects.toBeTruthy();
    expect(h.openApproval).not.toHaveBeenCalled();
  });
});

describe('handleCip30 — CIP-103 bulk signing (T6.5)', () => {
  const ownPaymentKeyHash = Address.fromString(ownAddr).paymentCreds.hash.toString();

  /** A wallet-owned UTxO with a distinguishable tx id. */
  function ownUtxo(idByte: string, index = 0, lovelace = 10_000_000n): UTxO {
    return new UTxO({
      utxoRef: { id: idByte.repeat(32), index },
      resolved: { address: ownAddr, value: Value.lovelaces(lovelace) },
    });
  }
  /** Build a real send tx spending exactly `utxos`, change back to the wallet. */
  function sendTx(utxos: UTxO[], lovelace = 3_000_000n): Tx {
    return buildSend(
      {
        protocolParameters: { ...defaultProtocolParameters, utxoCostPerByte: 4310 },
        genesisInfos: defaultPreviewGenesisInfos,
        utxos,
        changeAddress: ownAddr,
      },
      { toAddress: RECIPIENT, lovelace },
    );
  }
  const req = (tx: Tx, partialSign?: boolean) => ({
    cbor: toHex(tx.toCborBytes()),
    ...(partialSign === undefined ? {} : { partialSign }),
  });
  /** The change output a follow-up tx can chain off (the one paying back to the wallet). */
  function chainedUtxo(tx: Tx): UTxO {
    const index = tx.body.outputs.findIndex((o) => o.address.toString() === ownAddr);
    const resolved = tx.body.outputs[index];
    if (!resolved) throw new Error('no wallet-owned output to chain from');
    return new UTxO({ utxoRef: { id: tx.body.hash.toString(), index }, resolved });
  }
  /** vkey witnesses in the witness set at `i` of a signTxs result (fails loudly if it is missing). */
  function vkeysAt(witnesses: string[], i: number) {
    const hex = witnesses[i];
    if (hex === undefined) throw new Error(`no witness set at index ${i}`);
    return TxWitnessSet.fromCbor(hex).vkeyWitnesses ?? [];
  }
  const lastPayload = () =>
    h.setApprovalPayload.mock.calls[0]?.[1] as unknown as BulkSignApprovalPayload | undefined;

  beforeEach(() => {
    h.state.allow.add(ORIGIN);
    h.state.ext.set(ORIGIN, [103]);
    h.provider.resolveUtxos.mockClear();
    h.provider.resolveUtxos.mockResolvedValue([]);
  });

  it('is gated on negotiation: cip103.* without it → InvalidRequest (-1)', async () => {
    h.state.ext.set(ORIGIN, []); // enabled origin, extension NOT negotiated (raw-postMessage bypass)
    await expect(handleCip30('cip103.signTxs', [[req(sendTx([ownUtxo('aa')]))]], ORIGIN)).rejects.toMatchObject({ code: -1 });
    await expect(handleCip30('cip103.submitTxs', [['deadbeef']], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('signs a batch of INDEPENDENT txs → one witness set per tx, index-aligned', async () => {
    const u1 = ownUtxo('aa');
    const u2 = ownUtxo('bb');
    h.provider.resolveUtxos.mockResolvedValue([u1, u2]);
    const wits = (await handleCip30('cip103.signTxs', [[req(sendTx([u1])), req(sendTx([u2]))]], ORIGIN)) as string[];
    expect(wits).toHaveLength(2);
    for (const w of wits) {
      const vkeys = TxWitnessSet.fromCbor(w).vkeyWitnesses ?? [];
      expect(vkeys).toHaveLength(1);
      expect(vkeys[0]?.vkey.hash.toString()).toBe(ownPaymentKeyHash);
    }
  });

  it('CHAINED txs: an input created by an earlier batch tx resolves from the batch, not the chain', async () => {
    const u1 = ownUtxo('aa');
    const tx1 = sendTx([u1]);
    const tx2 = sendTx([chainedUtxo(tx1)], 1_000_000n);
    // Only tx1's input exists on-chain; tx2's input is tx1's not-yet-submitted change output.
    h.provider.resolveUtxos.mockResolvedValue([u1]);
    const wits = (await handleCip30('cip103.signTxs', [[req(tx1), req(tx2)]], ORIGIN)) as string[];
    expect(wits).toHaveLength(2);

    // The chain lookup was asked ONLY for the on-chain input — the in-batch one is resolved locally.
    expect(h.provider.resolveUtxos.mock.calls.at(-1)?.[0]).toHaveLength(1);
    const items = lastPayload()?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[1]?.dependsOn).toEqual([0]); // tx2 chains off tx1
    expect(items[0]?.dependsOn).toEqual([]);
    // Decode-before-sign holds for the chained tx too: its input is shown, not counted as unresolved.
    expect(items[1]?.summary.unresolvedInputs).toBe(0);
    expect(items[1]?.summary.inputs[0]?.address).toBe(ownAddr);
    // ...and its wallet-owned in-batch input still produced a real witness.
    expect(vkeysAt(wits, 1)).toHaveLength(1);
  });

  it('SAME-INPUT txs: two competing txs spending one UTxO both sign, and the conflict is disclosed', async () => {
    const u1 = ownUtxo('aa');
    const a = sendTx([u1], 3_000_000n);
    const b = sendTx([u1], 4_000_000n); // alternative spend of the SAME input
    h.provider.resolveUtxos.mockResolvedValue([u1]);
    const wits = (await handleCip30('cip103.signTxs', [[req(a), req(b)]], ORIGIN)) as string[];
    expect(wits).toHaveLength(2);
    expect(vkeysAt(wits, 0)).toHaveLength(1);
    expect(vkeysAt(wits, 1)).toHaveLength(1);
    // The shared input is fetched once, and BOTH summaries resolve it (nothing deduped away).
    expect(h.provider.resolveUtxos.mock.calls.at(-1)?.[0]).toHaveLength(1);
    const items = lastPayload()?.items ?? [];
    expect(items[0]?.summary.unresolvedInputs).toBe(0);
    expect(items[1]?.summary.unresolvedInputs).toBe(0);
    // Only one of them can ever settle — the approval says so.
    expect(items[0]?.conflictsWith).toEqual([1]);
    expect(items[1]?.conflictsWith).toEqual([0]);
  });

  it('a SHARED COLLATERAL utxo across the batch is not a conflict (normal for a Plutus chain)', async () => {
    // Two txs, different spending inputs, the SAME collateral UTxO — collateral is only consumed on a
    // phase-2 failure, so both can settle. Flagging this as "only one can settle" would be wrong.
    const u1 = ownUtxo('aa');
    const u2 = ownUtxo('bb');
    const coll = ownUtxo('cc', 0, 5_000_000n);
    const withCollateral = (input: UTxO) =>
      new Tx({
        body: new TxBody({
          inputs: [input],
          outputs: [new TxOut({ address: Address.fromString(RECIPIENT), value: Value.lovelaces(9_800_000n) })],
          fee: 200_000n,
          collateralInputs: [coll],
        }),
        witnesses: new TxWitnessSet({}),
      });
    h.provider.resolveUtxos.mockResolvedValue([u1, u2, coll]);
    await handleCip30('cip103.signTxs', [[req(withCollateral(u1)), req(withCollateral(u2))]], ORIGIN);
    const items = lastPayload()?.items ?? [];
    expect(items[0]?.conflictsWith).toEqual([]);
    expect(items[1]?.conflictsWith).toEqual([]);
  });

  it('a sibling tx\'s wallet-owned input never contributes a witness to another tx in the batch', async () => {
    // u2 belongs to tx2 only. tx1 (foreign input, partialSign) must come back with NO vkey witness —
    // resolving one union for the whole batch must not leak signatures across transactions.
    const foreign = new UTxO({
      utxoRef: { id: 'cc'.repeat(32), index: 0 },
      resolved: { address: RECIPIENT, value: Value.lovelaces(10_000_000n) },
    });
    const u2 = ownUtxo('bb');
    const tx1 = new Tx({
      body: new TxBody({
        inputs: [foreign],
        outputs: [new TxOut({ address: Address.fromString(RECIPIENT), value: Value.lovelaces(9_800_000n) })],
        fee: 200_000n,
      }),
      witnesses: new TxWitnessSet({}),
    });
    h.provider.resolveUtxos.mockResolvedValue([foreign, u2]);
    const wits = (await handleCip30('cip103.signTxs', [[req(tx1, true), req(sendTx([u2]))]], ORIGIN)) as string[];
    expect(vkeysAt(wits, 0)).toHaveLength(0);
    expect(vkeysAt(wits, 1)).toHaveLength(1);
  });

  it('opens ONE payload-pending prompt and delivers every decoded tx (no batch blind-sign)', async () => {
    const u1 = ownUtxo('aa');
    const u2 = ownUtxo('bb');
    h.provider.resolveUtxos.mockResolvedValue([u1, u2]);
    await handleCip30('cip103.signTxs', [[req(sendTx([u1])), req(sendTx([u2]))]], ORIGIN);
    expect(h.openApproval).toHaveBeenCalledTimes(1);
    expect(h.openApproval).toHaveBeenCalledWith('signTxs', ORIGIN, undefined, { payloadPending: true });
    const items = lastPayload()?.items ?? [];
    expect(items).toHaveLength(2);
    for (const it of items) expect(it.summary).toHaveProperty('outputs'); // decoded, not raw CBOR
  });

  it('decline → TxSignError UserDeclined (2), no witnesses', async () => {
    h.state.approve = false;
    const u1 = ownUtxo('aa');
    h.provider.resolveUtxos.mockResolvedValue([u1]);
    await expect(handleCip30('cip103.signTxs', [[req(sendTx([u1]))]], ORIGIN)).rejects.toMatchObject({ code: 2 });
  });

  it('an unsignable tx fails the WHOLE batch (ProofGeneration 1) naming its index', async () => {
    const u1 = ownUtxo('aa');
    const foreign = new UTxO({
      utxoRef: { id: 'cc'.repeat(32), index: 0 },
      resolved: { address: RECIPIENT, value: Value.lovelaces(10_000_000n) },
    });
    const unsignable = new Tx({
      body: new TxBody({
        inputs: [foreign],
        outputs: [new TxOut({ address: Address.fromString(RECIPIENT), value: Value.lovelaces(9_800_000n) })],
        fee: 200_000n,
      }),
      witnesses: new TxWitnessSet({}),
    });
    h.provider.resolveUtxos.mockResolvedValue([u1, foreign]);
    const err = (await handleCip30('cip103.signTxs', [[req(sendTx([u1])), req(unsignable)]], ORIGIN).catch(
      (e: unknown) => e,
    )) as Cip30Error;
    expect(err.code).toBe(1);
    expect(err.info).toContain('tx[1]');
  });

  it('malformed batches are rejected (-1) BEFORE any prompt opens, naming the bad index', async () => {
    const good = req(sendTx([ownUtxo('aa')]));
    for (const bad of [[], 'nope', undefined, [{ partialSign: true }], [good, { cbor: 42 }]]) {
      await expect(handleCip30('cip103.signTxs', [bad], ORIGIN)).rejects.toMatchObject({ code: -1 });
    }
    const err = (await handleCip30('cip103.signTxs', [[good, { cbor: 'zz-not-cbor' }]], ORIGIN).catch(
      (e: unknown) => e,
    )) as Cip30Error;
    expect(err.info).toContain('tx[1]');
    const partial = (await handleCip30('cip103.signTxs', [[{ ...good, partialSign: 'yes' }]], ORIGIN).catch(
      (e: unknown) => e,
    )) as Cip30Error;
    expect(partial.info).toContain('partialSign');
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it('caps the batch size (an unreviewable prompt is blind-signing) → InvalidRequest (-1)', async () => {
    const one = req(sendTx([ownUtxo('aa')]));
    await expect(handleCip30('cip103.signTxs', [Array(21).fill(one)], ORIGIN)).rejects.toMatchObject({ code: -1 });
    expect(h.openApproval).not.toHaveBeenCalled();
  });

  it('submitTxs: submits in order, attempts every tx despite a failure, returns mixed results', async () => {
    h.provider.submitTx
      .mockResolvedValueOnce('hash-a')
      .mockRejectedValueOnce(new ProviderHttpError(400, 'HTTP 400 for https://user:secret@x/api: ValueNotConserved'))
      .mockResolvedValueOnce('hash-c');
    const out = (await handleCip30('cip103.submitTxs', [['aa', 'bb', 'cc']], ORIGIN)) as unknown[];
    expect(h.provider.submitTx.mock.calls.map((c) => c[0])).toEqual(['aa', 'bb', 'cc']); // input order
    expect(out[0]).toBe('hash-a');
    expect(out[2]).toBe('hash-c');
    // The failure is a TxSendError entry in place, carrying the index — and NEVER the raw provider text.
    expect(out[1]).toEqual({ code: 2, info: 'tx[1]: provider rejected transaction' });
  });

  it('submitTxs: malformed input → InvalidRequest (-1), nothing submitted', async () => {
    for (const bad of [[], 'nope', [42], ['aa', ''], Array(21).fill('aa')]) {
      await expect(handleCip30('cip103.submitTxs', [bad], ORIGIN)).rejects.toMatchObject({ code: -1 });
    }
    expect(h.provider.submitTx).not.toHaveBeenCalled();
  });

  it('submitTxs needs an unlocked wallet', async () => {
    h.state.unlocked = false;
    await expect(handleCip30('cip103.submitTxs', [['aa']], ORIGIN)).rejects.toMatchObject({ code: -2 });
  });
});

describe('handleCip30 — experimental.resolveHandle (T8.1, dApp path)', () => {
  const HOLDER_HEX = toHex(Address.fromString(RECIPIENT).toBuffer());

  beforeEach(() => {
    h.state.allow.add(ORIGIN);
  });

  it('resolves a $handle to the holder address as CIP-30 hex bytes', async () => {
    h.provider.getAssetAddresses.mockResolvedValue([{ address: RECIPIENT, quantity: '1' }]);
    const hex = await handleCip30('resolveHandle', ['$alice'], ORIGIN);
    expect(hex).toBe(HOLDER_HEX);
  });

  it('needs no unlock (read-only chain lookup)', async () => {
    h.state.unlocked = false;
    h.provider.getAssetAddresses.mockResolvedValue([{ address: RECIPIENT, quantity: '1' }]);
    expect(await handleCip30('resolveHandle', ['alice'], ORIGIN)).toBe(HOLDER_HEX);
  });

  it('rejects an invalid handle (InvalidRequest -1) without hitting the provider', async () => {
    await expect(handleCip30('resolveHandle', ['$bad space'], ORIGIN)).rejects.toMatchObject({ code: -1 });
    expect(h.provider.getAssetAddresses).not.toHaveBeenCalled();
  });

  it('rejects a non-string handle argument (InvalidRequest -1)', async () => {
    await expect(handleCip30('resolveHandle', [42], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('an unminted handle → InvalidRequest (-1)', async () => {
    h.provider.getAssetAddresses.mockResolvedValue([]); // no holder under either unit
    await expect(handleCip30('resolveHandle', ['$nope'], ORIGIN)).rejects.toMatchObject({ code: -1 });
  });

  it('is origin-gated: a non-enabled origin → Refused (-3)', async () => {
    h.state.allow.delete(ORIGIN);
    await expect(handleCip30('resolveHandle', ['$alice'], ORIGIN)).rejects.toMatchObject({ code: -3 });
  });
});

describe('handleCip30 — discovery cache (dApp popup latency)', () => {
  beforeEach(() => {
    h.state.allow.add(ORIGIN);
  });

  it('a burst of read calls shares ONE walk per chain instead of re-discovering each time', async () => {
    await handleCip30('getUsedAddresses', [undefined], ORIGIN); // external chain
    await handleCip30('getChangeAddress', [], ORIGIN); // internal chain
    await handleCip30('getBalance', [], ORIGIN); // both chains — must hit the cache
    await handleCip30('getUtxos', [undefined, undefined], ORIGIN); // both chains — must hit the cache
    expect(h.discoverChain).toHaveBeenCalledTimes(2);
  });

  it('CONCURRENT calls share the in-flight walk (the promise is cached, not the result)', async () => {
    await Promise.all([
      handleCip30('getBalance', [], ORIGIN),
      handleCip30('getUsedAddresses', [undefined], ORIGIN),
      handleCip30('getChangeAddress', [], ORIGIN),
    ]);
    expect(h.discoverChain).toHaveBeenCalledTimes(2);
  });

  it('submitTx invalidates the cache (the change address may have become used)', async () => {
    await handleCip30('getBalance', [], ORIGIN);
    expect(h.discoverChain).toHaveBeenCalledTimes(2);
    await handleCip30('submitTx', ['deadbeef'], ORIGIN);
    await handleCip30('getBalance', [], ORIGIN);
    expect(h.discoverChain).toHaveBeenCalledTimes(4);
  });

  it('a FAILED walk is never cached — the next call retries', async () => {
    h.discoverChain.mockRejectedValueOnce(new Error('provider down'));
    await expect(handleCip30('getUsedAddresses', [undefined], ORIGIN)).rejects.toThrow('provider down');
    await handleCip30('getUsedAddresses', [undefined], ORIGIN);
    expect(h.discoverChain).toHaveBeenCalledTimes(2);
  });

  it('the cache expires after its TTL', async () => {
    vi.useFakeTimers();
    try {
      await handleCip30('getUsedAddresses', [undefined], ORIGIN);
      expect(h.discoverChain).toHaveBeenCalledTimes(1);
      await handleCip30('getUsedAddresses', [undefined], ORIGIN);
      expect(h.discoverChain).toHaveBeenCalledTimes(1); // within TTL → cached
      vi.advanceTimersByTime(11_000); // past DISCOVERY_TTL_MS
      await handleCip30('getUsedAddresses', [undefined], ORIGIN);
      expect(h.discoverChain).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a network switch uses a different cache entry (no stale cross-network addresses)', async () => {
    await handleCip30('getUsedAddresses', [undefined], ORIGIN);
    h.state.network = 'mainnet';
    await handleCip30('getUsedAddresses', [undefined], ORIGIN);
    expect(h.discoverChain).toHaveBeenCalledTimes(2);
  });
});
