// CIP-113 programmable tokens — read-only tier (EXECUTION_PLAN T9.1/T9.2): params validation,
// programmable-address computation, RegistryNode datum decoding, NFT-authenticated registry lookup,
// and the provider datum mapping the registry client depends on.
import { describe, it, expect } from 'vitest';
import { Address, DataConstr, UTxO, Value } from '@harmoniclabs/buildooor';
import { cip113ParamsFor, isValidCip113Params, type Cip113Params } from '../src/core/cip113/params';
import { ownProgrammableAddresses, programmableTokenAddress } from '../src/core/cip113/address';
import {
  decodeRegistryNode,
  findRegistryNode,
  isProgrammablePolicy,
  type RegistryLookup,
} from '../src/core/cip113/registry';
import { plutusDataFromJson, plutusDataToCbor } from '../src/core/tx/plutusData';
import { toUtxo } from '../src/background/provider/mappers';
import { fromHex } from '../src/core/crypto/encoding';

// ---- fixtures ----------------------------------------------------------------------------------

const LOGIC_BASE = 'cc'.repeat(28); // programmable_logic_base script hash
const REGISTRY_NFT_POLICY = 'bb'.repeat(28); // registry-node authenticity NFT policy
const TOKEN_POLICY = 'aa'.repeat(28); // a registered programmable-token policy
const OTHER_POLICY = 'dd'.repeat(28); // an unregistered native-token policy
const CRED_HASH = 'ee'.repeat(28); // any validator credential hash
const TX_HASH = '12'.repeat(32);

// Preview fixture address (see CLAUDE context) — a syntactically valid testnet base address.
const REGISTRY_ADDR =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

const PARAMS: Cip113Params = {
  programmableLogicBase: LOGIC_BASE,
  registryAddress: REGISTRY_ADDR,
  registryNodePolicyId: REGISTRY_NFT_POLICY,
};

/** Plutus `Credential` datum: constr 0 = key hash, constr 1 = script hash. */
const cred = (type: 'key' | 'script', hash = CRED_HASH) => ({
  constr: type === 'key' ? 0 : 1,
  fields: [{ bytes: hash }],
});

/** A full 7-field RegistryNode datum (upstream documented shape). */
function nodeDatumJson(key: string, next = '') {
  return {
    constr: 0,
    fields: [
      { bytes: key },
      { bytes: next },
      cred('script'), // minting_logic_script
      cred('script'), // transfer_logic_script
      cred('key'), // third_party_transfer_logic_script
      { bytes: '' }, // global_state_cs
      { list: [{ bytes: '000de140' }] }, // protected_prefixes
    ],
  };
}

/** A registry UTxO: datum + (by default) the authenticating NFT with token name == datum key. */
function registryUtxo(
  datumJson: unknown,
  opts: { nftPolicy?: string; nftName?: string | null; index?: number } = {},
): UTxO {
  const units = [{ unit: 'lovelace', quantity: '2000000' }];
  if (opts.nftName !== null) {
    const key = opts.nftName ?? ((datumJson as { fields: Array<{ bytes: string }> }).fields[0]?.bytes ?? '');
    units.push({ unit: `${opts.nftPolicy ?? REGISTRY_NFT_POLICY}${key}`, quantity: '1' });
  }
  return new UTxO({
    utxoRef: { id: TX_HASH, index: opts.index ?? 0 },
    resolved: {
      address: Address.fromString(REGISTRY_ADDR),
      value: Value.fromUnits(units),
      datum: plutusDataFromJson(datumJson),
    },
  });
}

/** Fake chain lookup recording which addresses were queried. */
function fakeLookup(utxos: UTxO[]): RegistryLookup & { queried: string[] } {
  const queried: string[] = [];
  return {
    queried,
    getUtxos: (address: string) => {
      queried.push(address);
      return Promise.resolve(utxos);
    },
  };
}

// ---- params ------------------------------------------------------------------------------------

describe('cip113 params', () => {
  it('returns undefined when nothing is configured (the default state — no built-in deployment)', () => {
    expect(cip113ParamsFor('preview')).toBeUndefined();
    expect(cip113ParamsFor('mainnet', {})).toBeUndefined();
  });

  it('returns a valid settings override for the active network only', () => {
    expect(cip113ParamsFor('preview', { preview: PARAMS })).toEqual(PARAMS);
    expect(cip113ParamsFor('preprod', { preview: PARAMS })).toBeUndefined();
  });

  it('rejects malformed overrides (trust-no-input: these come from storage)', () => {
    expect(isValidCip113Params({ ...PARAMS, programmableLogicBase: 'zz'.repeat(28) }, 'preview')).toBe(false);
    expect(isValidCip113Params({ ...PARAMS, registryNodePolicyId: 'aa' }, 'preview')).toBe(false);
    expect(isValidCip113Params({ ...PARAMS, registryAddress: 42 }, 'preview')).toBe(false);
    expect(isValidCip113Params(null, 'preview')).toBe(false);
  });

  it('rejects a registry address from the wrong network (cross-network config mistake)', () => {
    // A testnet registry address configured for mainnet must be ignored, and vice versa.
    expect(isValidCip113Params(PARAMS, 'mainnet')).toBe(false);
    expect(isValidCip113Params(PARAMS, 'preview')).toBe(true);
  });
});

// ---- programmable address ----------------------------------------------------------------------

describe('cip113 programmable address', () => {
  const stakeKeyHash = fromHex('ab'.repeat(28));
  const paymentKeyHash = fromHex('cd'.repeat(28));

  it('builds addr(script payment, key-hash stake) — header type 2 → bech32 addr_test1z…/addr1z…', () => {
    const testnet = programmableTokenAddress(LOGIC_BASE, stakeKeyHash, 'testnet');
    const mainnet = programmableTokenAddress(LOGIC_BASE, stakeKeyHash, 'mainnet');
    expect(testnet.startsWith('addr_test1z')).toBe(true);
    expect(mainnet.startsWith('addr1z')).toBe(true);
    // Round-trips through buildooor's parser (i.e. it is a real, well-formed base address).
    expect(Address.fromString(testnet).toString()).toBe(testnet);
  });

  it('ownership lives in the stake slot: different owner ⇒ different address, same payment part', () => {
    const a = programmableTokenAddress(LOGIC_BASE, stakeKeyHash, 'testnet');
    const b = programmableTokenAddress(LOGIC_BASE, paymentKeyHash, 'testnet');
    expect(a).not.toBe(b);
    expect(Address.fromString(a).paymentCreds.hash.toString()).toBe(LOGIC_BASE);
    expect(Address.fromString(b).paymentCreds.hash.toString()).toBe(LOGIC_BASE);
  });

  it('queries both owner conventions (stake key + payment key), deduped', () => {
    const both = ownProgrammableAddresses(PARAMS, { stakeKeyHash, paymentKeyHash }, 'testnet');
    expect(both).toHaveLength(2);
    const same = ownProgrammableAddresses(PARAMS, { stakeKeyHash, paymentKeyHash: stakeKeyHash }, 'testnet');
    expect(same).toHaveLength(1);
  });
});

// ---- RegistryNode datum decoding ---------------------------------------------------------------

describe('decodeRegistryNode', () => {
  it('decodes the documented 7-field node', () => {
    const node = decodeRegistryNode(plutusDataFromJson(nodeDatumJson(TOKEN_POLICY, OTHER_POLICY)));
    expect(node).toEqual({
      key: TOKEN_POLICY,
      next: OTHER_POLICY,
      mintingLogicScript: { type: 'script', hash: CRED_HASH },
      transferLogicScript: { type: 'script', hash: CRED_HASH },
      thirdPartyTransferLogicScript: { type: 'key', hash: CRED_HASH },
      globalStateCs: '',
      protectedPrefixes: ['000de140'],
    });
  });

  it('decodes the origin node (empty key/next sentinels)', () => {
    const node = decodeRegistryNode(plutusDataFromJson(nodeDatumJson('')));
    expect(node?.key).toBe('');
    expect(node?.next).toBe('');
  });

  it('tolerates a minimal 5-field node (optional tail fields absent)', () => {
    const json = nodeDatumJson(TOKEN_POLICY);
    json.fields = json.fields.slice(0, 5);
    const node = decodeRegistryNode(plutusDataFromJson(json));
    expect(node?.key).toBe(TOKEN_POLICY);
    expect(node?.globalStateCs).toBeUndefined();
    expect(node?.protectedPrefixes).toBeUndefined();
  });

  it('returns null for foreign shapes instead of throwing (untrusted chain data)', () => {
    expect(decodeRegistryNode(undefined)).toBeNull();
    expect(decodeRegistryNode(plutusDataFromJson({ int: 42 }))).toBeNull();
    // wrong constructor index
    expect(decodeRegistryNode(new DataConstr(1, []))).toBeNull();
    // too few fields
    expect(decodeRegistryNode(plutusDataFromJson({ constr: 0, fields: [{ bytes: TOKEN_POLICY }] }))).toBeNull();
    // key is not a policy id
    expect(decodeRegistryNode(plutusDataFromJson(nodeDatumJson('abcd')))).toBeNull();
    // credential field has a bogus constructor
    const badCred = nodeDatumJson(TOKEN_POLICY);
    badCred.fields[3] = { constr: 7, fields: [{ bytes: CRED_HASH }] };
    expect(decodeRegistryNode(plutusDataFromJson(badCred))).toBeNull();
  });
});

// ---- registry lookup ---------------------------------------------------------------------------

describe('findRegistryNode', () => {
  it('finds an NFT-authenticated node by policy id and reports its (fresh) utxoRef', async () => {
    const lookup = fakeLookup([
      registryUtxo(nodeDatumJson('')), // origin node
      registryUtxo(nodeDatumJson(TOKEN_POLICY), { index: 1 }),
    ]);
    const hit = await findRegistryNode(TOKEN_POLICY, PARAMS, lookup);
    expect(hit?.node.transferLogicScript).toEqual({ type: 'script', hash: CRED_HASH });
    expect(hit?.utxoRef).toEqual({ txHash: TX_HASH, index: 1 });
    expect(lookup.queried).toEqual([REGISTRY_ADDR]);
    await expect(isProgrammablePolicy(TOKEN_POLICY, PARAMS, lookup)).resolves.toBe(true);
  });

  it('returns null for an unregistered policy (a plain native asset)', async () => {
    const lookup = fakeLookup([registryUtxo(nodeDatumJson(TOKEN_POLICY))]);
    await expect(findRegistryNode(OTHER_POLICY, PARAMS, lookup)).resolves.toBeNull();
  });

  it('ignores a forged datum without the registry NFT (anti-spoof: NFT = authenticity)', async () => {
    const lookup = fakeLookup([registryUtxo(nodeDatumJson(TOKEN_POLICY), { nftName: null })]);
    await expect(findRegistryNode(TOKEN_POLICY, PARAMS, lookup)).resolves.toBeNull();
  });

  it('ignores a node whose NFT name does not match the datum key (upstream invariant)', async () => {
    const lookup = fakeLookup([registryUtxo(nodeDatumJson(TOKEN_POLICY), { nftName: OTHER_POLICY })]);
    await expect(findRegistryNode(TOKEN_POLICY, PARAMS, lookup)).resolves.toBeNull();
  });

  it('ignores an NFT under the wrong policy (same name, different policy — not a registry NFT)', async () => {
    const lookup = fakeLookup([registryUtxo(nodeDatumJson(TOKEN_POLICY), { nftPolicy: OTHER_POLICY })]);
    await expect(findRegistryNode(TOKEN_POLICY, PARAMS, lookup)).resolves.toBeNull();
  });

  it('rejects a malformed policy id without querying the chain (trust-no-input)', async () => {
    const lookup = fakeLookup([]);
    await expect(findRegistryNode('not-a-policy', PARAMS, lookup)).resolves.toBeNull();
    expect(lookup.queried).toEqual([]);
  });
});

// ---- provider datum mapping (the read path the registry client depends on) ----------------------

describe('toUtxo datum mapping', () => {
  const base = {
    txHash: TX_HASH,
    outputIndex: 0,
    address: REGISTRY_ADDR,
    amount: [{ unit: 'lovelace', quantity: '1000000' }],
  };

  it('maps an inline datum (CBOR hex) to PlutusData on the resolved output', () => {
    const inlineDatum = plutusDataToCbor(plutusDataFromJson(nodeDatumJson(TOKEN_POLICY)));
    const u = toUtxo({ ...base, inlineDatum });
    expect(decodeRegistryNode(u.resolved.datum)?.key).toBe(TOKEN_POLICY);
  });

  it('drops an unparseable inline datum instead of failing the query (untrusted chain data)', () => {
    const u = toUtxo({ ...base, inlineDatum: 'zzzz-not-cbor' });
    expect(u.resolved.datum).toBeUndefined();
  });

  it('keeps outputs without datums datum-free (regression: balance path unchanged)', () => {
    expect(toUtxo(base).resolved.datum).toBeUndefined();
  });
});
