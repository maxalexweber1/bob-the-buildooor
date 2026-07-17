// buildooor Tx → Ledger signing payload, and device witnesses → verified VKeyWitnesses
// (EXECUTION_PLAN T6.3).
//
// HOW LEDGER SIGNING WORKS (and why this file is paranoid): the device does NOT sign the CBOR we
// send. It re-serializes the transaction from the structured request below and signs
// blake2b_256(its own serialization). A witness is therefore only valid for OUR transaction if the
// device's byte layout matches buildooor's exactly. Two layout facts are load-bearing:
//   - buildooor serializes EVERY output in Babbage MAP format (TxOut.toCborObj → CborMap), so the
//     request must say so (`format: MAP_BABBAGE` — translated in options/ledgerDevice.ts);
//   - buildooor does NOT tag sets with CBOR tag 258, so `tagCborSets` must stay false.
// If the layouts ever drift, nothing unsafe happens: `applyHwWitnesses` verifies every signature
// against OUR body hash with the account xpub and rejects the whole batch on mismatch — the failure
// mode is a clear error, never a wrong submit.
//
// This module is deliberately free of the Ledger SDK: it emits a neutral, JSON-serializable payload
// (it must cross the background↔options message boundary), which `options/ledgerDevice.ts` translates
// into the SDK's enum-typed request in the page context that owns the transport.
import { Hash32, Signature, VKeyWitness, type Tx } from '@harmoniclabs/buildooor';
import { fromHex, toHex } from '../crypto/encoding';
import { PURPOSE, COIN_TYPE, Role } from '../keys';
import { verifyHwSignature, type HwAccountKeys } from './xpubAccount';

export const HARDENED = 0x80000000;

/** Chain networks, mirroring the provider union (kept local — core stays provider-free). */
export type HwNetwork = 'mainnet' | 'preview' | 'preprod';

/** Ledger `Network`: networkId for Shelley addresses, protocolMagic (relevant to Byron, required). */
export function ledgerNetwork(network: HwNetwork): { networkId: number; protocolMagic: number } {
  switch (network) {
    case 'mainnet':
      return { networkId: 1, protocolMagic: 764824073 };
    case 'preprod':
      return { networkId: 0, protocolMagic: 1 };
    case 'preview':
      return { networkId: 0, protocolMagic: 2 };
  }
}

/** A CIP-1852 signer under the hardware account: `role/index` (account fixed at 0 for now). */
export interface HwSigner {
  role: number;
  index: number;
}

/** m/1852'/1815'/account' */
export function accountPath(account = 0): number[] {
  return [PURPOSE + HARDENED, COIN_TYPE + HARDENED, account + HARDENED];
}

/** m/1852'/1815'/account'/role/index — the witness path for one signer. */
export function signerPath(signer: HwSigner, account = 0): number[] {
  return [...accountPath(account), signer.role, signer.index];
}

/** Thrown when the tx carries a feature the hardware path does not support yet (v1: plain sends). */
export class HwUnsupportedError extends Error {
  constructor(feature: string) {
    super(`this transaction needs ${feature}, which the Ledger flow does not support yet`);
    this.name = 'HwUnsupportedError';
  }
}

/** Thrown when device output fails verification — the safe abort for any byte-layout drift. */
export class HwWitnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HwWitnessError';
  }
}

export interface LedgerOutputPayload {
  amount: string;
  tokenBundle: Array<{ policyIdHex: string; tokens: Array<{ assetNameHex: string; amount: string }> }>;
  /** Third-party carries the address in both encodings: Ledger wants hex bytes, Trezor bech32. */
  destination:
    | { kind: 'third_party'; addressHex: string; addressBech32: string }
    | { kind: 'device_owned'; spendingPath: number[]; stakingPath: number[] };
}

/** Neutral, JSON-serializable signing payload (translated to SDK types in the options page). */
export interface LedgerTxPayload {
  network: { networkId: number; protocolMagic: number };
  inputs: Array<{ txHashHex: string; outputIndex: number; path: number[] }>;
  outputs: LedgerOutputPayload[];
  fee: string;
  ttl?: string;
  validityIntervalStart?: string;
  /** blake2b_256 auxiliary-data hash (CIP-20 memo etc.) — the device shows the hash only. */
  auxDataHashHex?: string;
  includeNetworkId?: boolean;
}

export interface MapTxContext {
  network: HwNetwork;
  /** Owner (role/index) of each wallet input, keyed by `utxoRef.toString()`. */
  inputOwners: Map<string, HwSigner>;
  /** Owner of each device-owned output address (change), keyed by bech32 address. */
  ownedAddresses: Map<string, HwSigner>;
  account?: number;
}

/** buildooor `Value.toJson()` shape (mirrors core/balance.ts). */
type ValueJson = Record<string, Record<string, string>>;

/** Ledger enforces canonically ordered token bundles; buildooor emits them in build order, which for
 *  our own builds is already sorted — sorting here keeps the request valid regardless. */
function tokenBundleFrom(json: ValueJson): LedgerOutputPayload['tokenBundle'] {
  return Object.entries(json)
    .filter(([policy]) => policy !== '')
    .map(([policyIdHex, assets]) => ({
      policyIdHex,
      tokens: Object.entries(assets)
        .map(([assetNameHex, amount]) => ({ assetNameHex, amount }))
        .sort((a, b) => (a.assetNameHex < b.assetNameHex ? -1 : 1)),
    }))
    .sort((a, b) => (a.policyIdHex < b.policyIdHex ? -1 : 1));
}

/**
 * Map a built (unsigned) tx into the Ledger signing payload + the signers whose witnesses we expect
 * back. Only plain payments are supported (exactly what `buildSend` produces); any other body field
 * aborts with `HwUnsupportedError` — never silently dropped, the device must see the WHOLE tx or
 * nothing (CLAUDE.md §1.5 applies to the device display too).
 */
export function mapTxForLedger(tx: Tx, ctx: MapTxContext): { payload: LedgerTxPayload; signers: HwSigner[] } {
  const body = tx.body;

  // Reject everything outside the supported envelope, by name, so the error is actionable.
  const unsupported: Array<[string, unknown]> = [
    ['certificates', body.certs?.length ? body.certs : undefined],
    ['withdrawals', body.withdrawals],
    ['minting', body.mint],
    ['Plutus scripts (scriptDataHash)', body.scriptDataHash],
    ['collateral inputs', body.collateralInputs?.length ? body.collateralInputs : undefined],
    ['required signers', body.requiredSigners?.length ? body.requiredSigners : undefined],
    ['collateral return', body.collateralReturn],
    ['total collateral', body.totCollateral],
    ['reference inputs', body.refInputs?.length ? body.refInputs : undefined],
    ['votes', body.votingProcedures],
    ['governance proposals', body.proposalProcedures?.length ? body.proposalProcedures : undefined],
    ['treasury value', body.currentTreasuryValue],
    ['treasury donation', body.donation],
    ['protocol update', body.protocolUpdate],
  ];
  for (const [feature, value] of unsupported) {
    if (value !== undefined) throw new HwUnsupportedError(feature);
  }

  const signerByKey = new Map<string, HwSigner>();
  const inputs = body.inputs.map((u) => {
    const owner = ctx.inputOwners.get(u.utxoRef.toString());
    // Every input must be device-signable; a foreign input can't produce a witness on this device.
    if (!owner) throw new HwUnsupportedError(`an input the account does not own (${u.utxoRef.toString()})`);
    signerByKey.set(`${owner.role}/${owner.index}`, owner);
    return {
      txHashHex: u.utxoRef.id.toString(),
      outputIndex: u.utxoRef.index,
      path: signerPath(owner, ctx.account ?? 0),
    };
  });

  const outputs = body.outputs.map((out): LedgerOutputPayload => {
    const valueJson = (out.value as unknown as { toJson(): ValueJson }).toJson();
    const amount = valueJson['']?.[''] ?? '0';
    const addressStr = out.address.toString();
    const owner = ctx.ownedAddresses.get(addressStr);
    return {
      amount,
      tokenBundle: tokenBundleFrom(valueJson),
      destination: owner
        ? {
            kind: 'device_owned',
            spendingPath: signerPath(owner, ctx.account ?? 0),
            stakingPath: signerPath({ role: Role.Staking, index: 0 }, ctx.account ?? 0),
          }
        : {
            kind: 'third_party',
            addressHex: toHex(new Uint8Array(out.address.toBytes())),
            addressBech32: addressStr,
          },
    };
  });

  const payload: LedgerTxPayload = {
    network: ledgerNetwork(ctx.network),
    inputs,
    outputs,
    fee: body.fee.toString(),
    ...(body.ttl !== undefined ? { ttl: body.ttl.toString() } : {}),
    ...(body.validityIntervalStart !== undefined
      ? { validityIntervalStart: body.validityIntervalStart.toString() }
      : {}),
    ...(body.auxDataHash !== undefined ? { auxDataHashHex: body.auxDataHash.toString() } : {}),
    ...(body.network !== undefined ? { includeNetworkId: true } : {}),
  };
  return { payload, signers: [...signerByKey.values()] };
}

/**
 * One device witness. Ledger identifies the signing key by BIP32 `path`; Trezor by the raw
 * `pubKeyHex`. Exactly one identifier is required — the signature is ALWAYS verified against the
 * xpub-derived key for the matched signer, never against a device-claimed key alone.
 */
export interface HwWitness {
  path?: number[];
  pubKeyHex?: string;
  witnessSignatureHex: string;
}

const SIG_HEX_RE = /^[0-9a-f]{128}$/i;

function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Does this witness identify `signer` — by exact path (Ledger) or by derived pubkey (Trezor)? */
function witnessMatchesSigner(
  wit: HwWitness,
  signer: HwSigner,
  keys: HwAccountKeys,
  account: number,
): boolean {
  if (wit.path) return pathsEqual(wit.path, signerPath(signer, account));
  if (wit.pubKeyHex) {
    const derived = toHex(keys.accountXpub.derive(signer.role).derive(signer.index).toPubKeyBytes());
    return wit.pubKeyHex.toLowerCase() === derived;
  }
  return false;
}

/**
 * Verify device witnesses against OUR transaction and attach them. The gate for everything the
 * device returns (trust-no-input):
 *  - the device-reported tx hash must equal blake2b_256 of the body we will submit (catches any
 *    serialization drift with a precise diagnostic);
 *  - exactly the expected signer set must be covered — no missing, no unexpected paths;
 *  - every signature must verify against the xpub-derived public key for its path.
 * Throws `HwWitnessError` on any violation; on success the witnesses are added to `tx` in place.
 */
export function applyHwWitnesses(
  tx: Tx,
  witnesses: HwWitness[],
  deviceTxHashHex: string,
  keys: HwAccountKeys,
  expectedSigners: HwSigner[],
  account = 0,
): void {
  const bodyHashHex = tx.body.hash.toString();
  if (deviceTxHashHex.toLowerCase() !== bodyHashHex.toLowerCase()) {
    throw new HwWitnessError(
      'the device signed a differently-serialized transaction (tx hash mismatch) — nothing was submitted',
    );
  }
  const bodyHash = fromHex(bodyHashHex);

  if (witnesses.length !== expectedSigners.length) {
    throw new HwWitnessError(
      `expected ${expectedSigners.length} witness(es), the device returned ${witnesses.length}`,
    );
  }

  for (const signer of expectedSigners) {
    const wit = witnesses.find((w) => witnessMatchesSigner(w, signer, keys, account));
    if (!wit) throw new HwWitnessError(`missing witness for key path ${signer.role}/${signer.index}`);
    if (!SIG_HEX_RE.test(wit.witnessSignatureHex)) throw new HwWitnessError('malformed witness signature');

    const signature = fromHex(wit.witnessSignatureHex);
    if (!verifyHwSignature(keys, signer.role, signer.index, bodyHash, signature)) {
      throw new HwWitnessError('a device signature failed verification against the transaction — nothing was submitted');
    }
    // IVkey types the public key as Hash32 (VKey is a 32-byte wrapper the constructor normalizes).
    tx.addVKeyWitness(
      new VKeyWitness({
        vkey: new Hash32(keys.accountXpub.derive(signer.role).derive(signer.index).toPubKeyBytes()),
        signature: new Signature(signature),
      }),
    );
  }
}
