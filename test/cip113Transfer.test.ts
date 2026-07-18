// CIP-113 programmable-token TRANSFER builder (T9.4 — experimental). No public deployment exists,
// so the whole validator world is a self-consistent fixture: three distinct always-succeeds Plutus
// V3 scripts play base / global / transfer-logic, their hashes define the config, and the registry
// node datum points at the transfer-logic hash — exactly the wiring a real deployment would have.
import { describe, it, expect } from 'vitest';
import {
  Address,
  Credential,
  Lambda,
  Script,
  Tx,
  TxRedeemerTag,
  UPLCConst,
  UPLCProgram,
  UTxO,
  Value,
  compileUPLC,
  defaultProtocolParameters,
  defaultPreviewGenesisInfos,
} from '@harmoniclabs/buildooor';
import { mnemonicToRoot } from '../src/core/keys';
import { accountKeys, baseAddress } from '../src/core/address';
import {
  Cip113TransferError,
  buildProgrammableTransfer,
  recipientProgrammableAddress,
  transferActRedeemer,
  type ProgrammableTransferParams,
} from '../src/core/cip113/transfer';
import { programmableTokenAddress } from '../src/core/cip113/address';
import { decodeRegistryNode, type RegistryNodeRef } from '../src/core/cip113/registry';
import { plutusDataFromJson, plutusDataToCbor } from '../src/core/tx/plutusData';
import { isValidCip113Params, type Cip113Params } from '../src/core/cip113/params';
import { toHex } from '../src/core/crypto/encoding';

// ---- fixture validator world --------------------------------------------------------------------

/** Distinct always-succeeds V3 scripts (different constant bodies → different hashes). */
const lam = (body: UPLCConst) => Script.plutusV3(compileUPLC(new UPLCProgram([1, 1, 0], new Lambda(body))));
const baseScript = lam(UPLCConst.unit);
const globalScript = lam(UPLCConst.int(1));
const transferLogicScript = lam(UPLCConst.bool(true));

const BASE_HASH = baseScript.hash.toString();
const GLOBAL_HASH = globalScript.hash.toString();
const TRANSFER_HASH = transferLogicScript.hash.toString();

const TOKEN_POLICY = 'aa'.repeat(28);
const TOKEN_NAME = '54455354'; // "TEST"
const UNIT = TOKEN_POLICY + TOKEN_NAME;
const REGISTRY_NFT_POLICY = 'bb'.repeat(28);
const REGISTRY_ADDR =
  'addr_test1qqetxfc069tpemq25f954mrg2rxsr9jgvqe78hvyn9zuxxdvaqvlg96unszfywdfrjwq0m8zp0m7wjza0n2pfeep5h7qw62gd8';

const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
const keys = accountKeys(root, 0);
const senderRegularAddr = baseAddress(root, 'testnet', 0, 0);
const senderProgAddr = programmableTokenAddress(BASE_HASH, keys.stakeKeyHash, 'testnet');
// A DIFFERENT wallet's base address as the recipient (its stake credential becomes the owner slot).
// BIP39 test vector: "legal winner …" (valid checksum, unlike an arbitrary word swap).
const RECIPIENT_BASE = baseAddress(
  mnemonicToRoot('legal winner thank year wave sausage worth useful legal winner thank yellow'),
  'testnet',
  0,
  0,
);

const TRANSFER_CFG = {
  programmableLogicGlobal: GLOBAL_HASH,
  protocolParamsRef: `${'dd'.repeat(32)}#1`,
  scripts: {
    base: toHex(baseScript.bytes),
    global: toHex(globalScript.bytes),
    transferLogic: { [TOKEN_POLICY]: toHex(transferLogicScript.bytes) },
  },
};
const CIP113: Cip113Params = {
  programmableLogicBase: BASE_HASH,
  registryAddress: REGISTRY_ADDR,
  registryNodePolicyId: REGISTRY_NFT_POLICY,
  transfer: TRANSFER_CFG,
};

const nodeDatum = plutusDataFromJson({
  constr: 0,
  fields: [
    { bytes: TOKEN_POLICY },
    { bytes: '' },
    { constr: 1, fields: [{ bytes: 'ee'.repeat(28) }] }, // minting logic (unused here)
    { constr: 1, fields: [{ bytes: TRANSFER_HASH }] }, // transfer logic — must match the config
    { constr: 0, fields: [{ bytes: 'ee'.repeat(28) }] }, // third-party logic
  ],
});

const registryNodeUtxo = new UTxO({
  utxoRef: { id: 'cc'.repeat(32), index: 0 },
  resolved: {
    address: Address.fromString(REGISTRY_ADDR),
    value: Value.fromUnits([
      { unit: 'lovelace', quantity: '2000000' },
      { unit: REGISTRY_NFT_POLICY + TOKEN_POLICY, quantity: '1' },
    ]),
    datum: nodeDatum,
  },
});
const registryNode: RegistryNodeRef = (() => {
  const node = decodeRegistryNode(nodeDatum);
  if (!node) throw new Error('fixture datum must decode');
  return { node, utxoRef: { txHash: 'cc'.repeat(32), index: 0 } };
})();

const protocolParamsUtxo = new UTxO({
  utxoRef: { id: 'dd'.repeat(32), index: 1 },
  resolved: { address: Address.fromString(REGISTRY_ADDR), value: Value.lovelaces(2_000_000n) },
});

const pp = { ...defaultProtocolParameters, utxoCostPerByte: 4310, txFeePerByte: 44, txFeeFixed: 155381 };

function makeParams(overrides: Partial<ProgrammableTransferParams> = {}): ProgrammableTransferParams {
  const sourceUtxo = new UTxO({
    utxoRef: { id: 'ee'.repeat(32), index: 0 },
    resolved: {
      address: Address.fromString(senderProgAddr),
      value: Value.fromUnits([
        { unit: 'lovelace', quantity: '2000000' },
        { unit: UNIT, quantity: '5' },
      ]),
    },
  });
  const fundingUtxo = new UTxO({
    utxoRef: { id: 'ff'.repeat(32), index: 0 },
    resolved: { address: Address.fromString(senderRegularAddr), value: Value.lovelaces(20_000_000n) },
  });
  const collateral = new UTxO({
    utxoRef: { id: 'ff'.repeat(32), index: 1 },
    resolved: { address: Address.fromString(senderRegularAddr), value: Value.lovelaces(5_000_000n) },
  });
  return {
    protocolParameters: pp,
    genesisInfos: defaultPreviewGenesisInfos,
    network: 'testnet',
    cip113: CIP113,
    registryNode,
    registryNodeUtxo,
    protocolParamsUtxo,
    sourceUtxos: [sourceUtxo],
    unit: UNIT,
    quantity: 3n,
    recipientBaseAddress: RECIPIENT_BASE,
    senderProgrammableAddress: senderProgAddr,
    senderStakeKeyHash: keys.stakeKeyHash,
    collateral,
    fundingUtxos: [fundingUtxo],
    changeAddress: senderRegularAddr,
    ...overrides,
  };
}

// ---- the happy path ------------------------------------------------------------------------------

describe('buildProgrammableTransfer (T9.4)', () => {
  const tx = buildProgrammableTransfer(makeParams());

  it('sends the tokens to addr(base, recipientStakeCred) and token change back to the sender', () => {
    const recipientProg = recipientProgrammableAddress(CIP113, RECIPIENT_BASE, 'testnet');
    const [toOut, changeToken] = tx.body.outputs;
    expect(toOut?.address.toString()).toBe(recipientProg);
    expect(toOut?.address.paymentCreds.hash.toString()).toBe(BASE_HASH);
    expect((toOut?.value.toJson() as Record<string, Record<string, string>>)[TOKEN_POLICY]?.[TOKEN_NAME]).toBe('3');
    // Partial send → the remaining 2 tokens return to the SENDER's programmable address.
    expect(changeToken?.address.toString()).toBe(senderProgAddr);
    expect(
      (changeToken?.value.toJson() as Record<string, Record<string, string>>)[TOKEN_POLICY]?.[TOKEN_NAME],
    ).toBe('2');
  });

  it('selects only the needed ADA-only funding — never sweeps the pool or token UTxOs', () => {
    // Live regression (preview tx ce7944bb…): passing the whole wallet as fundingUtxos used to
    // spend EVERYTHING — 7000+ ADA and every unrelated asset consolidated through one Plutus tx.
    const tokenBundle = new UTxO({
      utxoRef: { id: 'ab'.repeat(32), index: 0 },
      resolved: {
        address: Address.fromString(senderRegularAddr),
        value: Value.fromUnits([
          { unit: 'lovelace', quantity: '5000000000' },
          { unit: 'ab'.repeat(28) + 'aa', quantity: '7' },
        ]),
      },
    });
    const adaSmall = new UTxO({
      utxoRef: { id: 'ba'.repeat(32), index: 0 },
      resolved: { address: Address.fromString(senderRegularAddr), value: Value.lovelaces(20_000_000n) },
    });
    const selective = buildProgrammableTransfer(
      makeParams({ fundingUtxos: [tokenBundle, adaSmall] }),
    );
    const inputIds = selective.body.inputs.map((i) => i.utxoRef.toString());
    expect(inputIds).toContain(`${'ee'.repeat(32)}#0`); // the programmable source
    expect(inputIds).toContain(`${'ba'.repeat(32)}#0`); // the ADA-only funding it needs
    expect(inputIds).not.toContain(`${'ab'.repeat(32)}#0`); // the token bundle stays untouched
  });

  it('carries both mandatory reference inputs, registry node at the proof index', () => {
    const refs = (tx.body.refInputs ?? []).map((u) => u.utxoRef.toString());
    expect(refs[0]).toBe(`${'cc'.repeat(32)}#0`);
    expect(refs).toContain(`${'dd'.repeat(32)}#1`);
  });

  it('carries both withdraw-zero invocations on the TESTNET network (mainnet-default hazard)', () => {
    // Round-trip through CBOR — what matters is the serialized reward-account bytes, not JS state.
    const parsed = Tx.fromCbor(toHex(tx.toCborBytes()));
    const entries = parsed.body.withdrawals?.map ?? [];
    expect(entries).toHaveLength(2);
    const hashes = entries.map((e) => e.rewardAccount.credentials.toString()).sort();
    expect(hashes).toEqual([GLOBAL_HASH, TRANSFER_HASH].sort());
    for (const e of entries) {
      expect(e.amount).toBe(0n);
      expect(e.rewardAccount.network).toBe('testnet');
    }
  });

  it('requires the sender STAKE key signature (ownership inverts the payment-key model)', () => {
    const signers = (tx.body.requiredSigners ?? []).map((h) => h.toString());
    expect(signers).toContain(toHex(keys.stakeKeyHash));
  });

  it('attaches the TransferAct{TokenExists{0}} redeemer for the global validator', () => {
    const wanted = plutusDataToCbor(transferActRedeemer(0));
    const redeemers = tx.witnesses.redeemers ?? [];
    const withdrawRedeemers = redeemers.filter((r) => r.tag === TxRedeemerTag.Withdraw);
    expect(withdrawRedeemers).toHaveLength(2);
    expect(withdrawRedeemers.some((r) => plutusDataToCbor(r.data) === wanted)).toBe(true);
  });

  it('produces a CBOR round-trippable tx with a script data hash (Plutus witness world intact)', () => {
    expect(tx.body.scriptDataHash).toBeDefined();
    expect(() => Tx.fromCbor(toHex(tx.toCborBytes()))).not.toThrow();
  });
});

// ---- refusal paths (all Cip113TransferError, nothing signable) ------------------------------------

describe('buildProgrammableTransfer — refusals', () => {
  it('rejects a config script whose hash does not match its credential (wrong/stale script)', () => {
    const bad: Cip113Params = {
      ...CIP113,
      transfer: {
        ...TRANSFER_CFG,
        scripts: { ...TRANSFER_CFG.scripts, global: toHex(baseScript.bytes) }, // wrong script
      },
    };
    expect(() => buildProgrammableTransfer(makeParams({ cip113: bad }))).toThrow(Cip113TransferError);
    expect(() => buildProgrammableTransfer(makeParams({ cip113: bad }))).toThrow(/hashes to/);
  });

  it('rejects a transfer-logic script that does not match the REGISTRY node credential', () => {
    const bad: Cip113Params = {
      ...CIP113,
      transfer: {
        ...TRANSFER_CFG,
        scripts: { ...TRANSFER_CFG.scripts, transferLogic: { [TOKEN_POLICY]: toHex(globalScript.bytes) } },
      },
    };
    expect(() => buildProgrammableTransfer(makeParams({ cip113: bad }))).toThrow(/transfer-logic/);
  });

  it('rejects insufficient token balance', () => {
    expect(() => buildProgrammableTransfer(makeParams({ quantity: 6n }))).toThrow(/insufficient/);
  });

  it('rejects a recipient without a stake-key credential (enterprise address)', () => {
    const enterprise = Address.testnet(Credential.keyHash(keys.stakeKeyHash)).toString();
    expect(() => buildProgrammableTransfer(makeParams({ recipientBaseAddress: enterprise }))).toThrow(
      /stake-key credential/,
    );
  });

  it('rejects a registry node for a different policy', () => {
    const foreignNode: RegistryNodeRef = {
      node: { ...registryNode.node, key: 'ff'.repeat(28) },
      utxoRef: registryNode.utxoRef,
    };
    expect(() => buildProgrammableTransfer(makeParams({ registryNode: foreignNode }))).toThrow(
      /does not belong/,
    );
  });

  it('rejects when transfer params are missing (read-only tier only)', () => {
    const readOnly: Cip113Params = {
      programmableLogicBase: BASE_HASH,
      registryAddress: REGISTRY_ADDR,
      registryNodePolicyId: REGISTRY_NFT_POLICY,
    };
    expect(() => buildProgrammableTransfer(makeParams({ cip113: readOnly }))).toThrow(/no CIP-113 transfer/);
  });
});

// ---- params validation of the transfer block ------------------------------------------------------

describe('cip113 transfer params validation', () => {
  it('accepts the fixture config and rejects malformed variants', () => {
    expect(isValidCip113Params(CIP113, 'preview')).toBe(true);
    const badRef = { ...CIP113, transfer: { ...TRANSFER_CFG, protocolParamsRef: 'nope' } };
    expect(isValidCip113Params(badRef, 'preview')).toBe(false);
    const badPolicy = {
      ...CIP113,
      transfer: { ...TRANSFER_CFG, scripts: { ...TRANSFER_CFG.scripts, transferLogic: { zz: 'aabb' } } },
    };
    expect(isValidCip113Params(badPolicy, 'preview')).toBe(false);
  });
});
