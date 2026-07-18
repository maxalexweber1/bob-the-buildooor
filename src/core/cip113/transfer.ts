// CIP-113 programmable-token transfer builder (EXECUTION_PLAN T9.4 — EXPERIMENTAL, testnet only;
// gate lifted by human decision 2026-07-17). Builds the transaction shape mandated by the upstream
// integration guide (cardano-foundation/cip113-programmable-tokens, 08-INTEGRATION-GUIDES):
//
//   inputs:      sender's UTxO(s) at addr(programmable_logic_base, senderStakeCred)  [script spend]
//                + regular wallet UTxOs for fee/min-ADA
//   outputs:     addr(programmable_logic_base, recipientStakeCred) + tokens + min-ADA
//                + (when partial) remaining tokens BACK to the sender's programmable address
//   ref inputs:  protocol-params UTxO + the token's registry-node UTxO (resolved FRESH — T9.1 rule)
//   withdrawals: (programmable_logic_global, 0) + (transfer_logic_script, 0)   [withdraw-zero]
//   redeemers:   global ← TransferAct{ proofs: [TokenExists{ node_idx }] }; spend/transfer ← unit
//   signers:     requiredSigners = [sender's STAKE key hash]  (ownership = stake credential)
//   collateral:  ADA-only wallet UTxO
//
// UPSTREAM-UNDOCUMENTED SHAPES (re-verify against the deployed contracts before real use — the
// reference implementation does not pin them down):
//  - constructor indices: TransferAct = constr 0 (listed first in the docs), TokenExists = constr 0,
//    TokenDoesNotExist = constr 1;
//  - the base spend validator ignores its redeemer (`spend(_datum, _redeemer, …)`) → unit constr 0;
//  - the transfer-logic redeemer is substandard-specific → unit constr 0 by default;
//  - the recipient output's datum: undocumented → we PRESERVE the source UTxO's inline datum.
//
// Safety: every configured script is HASH-VERIFIED against its expected on-chain credential (the
// registry node's, for transfer logic) before it is attached, and the built tx is POSTCONDITION-
// checked (registry node_idx matches the redeemer; both zero-withdrawals present; programmable
// tokens only ever at programmable addresses). Any mismatch throws — never a signable wrong tx.
import {
  Address,
  Credential,
  DataConstr,
  DataI,
  DataList,
  Script,
  StakeAddress,
  StakeCredentials,
  StakeValidatorHash,
  TxBuilder,
  Value,
  forceTxOutRef,
  type Data,
  type GenesisInfos,
  type ProtocolParameters,
  type Tx,
  type UTxO,
} from '@harmoniclabs/buildooor';
import { fromHex } from '../crypto/encoding';
import { selectInputs } from '../tx/coinSelect';
import { valueView } from '../balance';
import type { Cip113Params, Cip113TransferParams } from './params';
import type { RegistryNodeRef } from './registry';

export class Cip113TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Cip113TransferError';
  }
}

/** Unit-ish redeemer (constr 0, no fields) — for validators documented to ignore their redeemer. */
export function unitRedeemer(): Data {
  return new DataConstr(0, []);
}

/** `TransferAct { proofs: [TokenExists { node_idx }] }` (constructor indices per upstream listing). */
export function transferActRedeemer(nodeIdx: number): Data {
  const tokenExists = new DataConstr(0, [new DataI(BigInt(nodeIdx))]);
  return new DataConstr(0, [new DataList([tokenExists])]);
}

/** Parse `txHash#index` (validated upstream in params.ts, but never trust twice-removed input). */
export function parseUtxoRef(ref: string): { id: string; index: number } {
  const [id, idx] = ref.split('#');
  if (!id || !/^[0-9a-f]{64}$/i.test(id) || idx === undefined) {
    throw new Cip113TransferError(`malformed UTxO ref: ${ref}`);
  }
  return { id: id.toLowerCase(), index: Number(idx) };
}

/** Load + hash-verify a configured script against the credential it must satisfy. */
function verifiedScript(cborHex: string, expectedHash: string, label: string): Script {
  let script: Script;
  try {
    script = Script.plutusV3(fromHex(cborHex));
  } catch {
    throw new Cip113TransferError(`the configured ${label} script is not valid CBOR`);
  }
  const got = script.hash.toString();
  if (got !== expectedHash.toLowerCase()) {
    throw new Cip113TransferError(
      `the configured ${label} script hashes to ${got}, expected ${expectedHash} — wrong or stale script`,
    );
  }
  return script;
}

export interface ProgrammableTransferParams {
  protocolParameters: ProtocolParameters; // MUST carry the chain's real cost models
  genesisInfos: GenesisInfos;
  network: 'mainnet' | 'testnet';
  cip113: Cip113Params;
  /** Freshly-resolved registry node for the token's policy (T9.1: NEVER cached across builds). */
  registryNode: RegistryNodeRef;
  /** The resolved registry-node UTxO and protocol-params UTxO (reference inputs, in that order). */
  registryNodeUtxo: UTxO;
  protocolParamsUtxo: UTxO;
  /** Sender's programmable-address UTxOs holding the token (script inputs). */
  sourceUtxos: UTxO[];
  /** unit = policyId + assetNameHex; quantity to transfer. */
  unit: string;
  quantity: bigint;
  /** RECIPIENT's regular base address — their stake credential becomes the new owner slot. */
  recipientBaseAddress: string;
  /** Sender's own programmable address (token change returns here, never to a regular address). */
  senderProgrammableAddress: string;
  /** Sender's stake key hash (the authorizing credential → requiredSigners). */
  senderStakeKeyHash: Uint8Array;
  /** ADA-only collateral UTxO from the sender's regular wallet. */
  collateral: UTxO;
  /** CANDIDATE pool of regular wallet UTxOs (typically the whole wallet, minus the collateral).
   *  The builder SELECTS from it — only what fee/min-ADA actually need is spent. */
  fundingUtxos: UTxO[];
  /** Regular wallet change address (ADA only — programmable tokens never route here). */
  changeAddress: string;
  /** Min-ADA attached to each programmable output (min-UTxO applies; 2 ADA is a safe floor). */
  outputLovelace?: bigint;
}

/** The recipient's programmable address: shared base script + THEIR stake credential. */
export function recipientProgrammableAddress(
  cip113: Cip113Params,
  recipientBaseAddress: string,
  network: 'mainnet' | 'testnet',
): string {
  const recipient = Address.fromString(recipientBaseAddress);
  const stake = recipient.stakeCreds;
  // Owner slot must be a stake KEY hash (v1) — reject pointer/script/enterprise recipient addresses.
  const hash = stake !== undefined && stake.type === 'stakeKey' && !Array.isArray(stake.hash) ? stake.hash : undefined;
  if (hash === undefined) {
    throw new Cip113TransferError(
      'the recipient address has no stake-key credential — programmable tokens need one for ownership',
    );
  }
  const pay = Credential.script(cip113.programmableLogicBase);
  const owner = StakeCredentials.keyHash(hash);
  return (network === 'mainnet' ? Address.mainnet(pay, owner) : Address.testnet(pay, owner)).toString();
}

/** buildooor `Value.toJson()` shape. */
type ValueJson = Record<string, Record<string, string>>;

function quantityOf(utxos: UTxO[], unit: string): bigint {
  const policy = unit.slice(0, 56);
  const name = unit.slice(56);
  let total = 0n;
  for (const u of utxos) {
    const json = (u.resolved.value as unknown as { toJson(): ValueJson }).toJson();
    total += BigInt(json[policy]?.[name] ?? '0');
  }
  return total;
}

export function buildProgrammableTransfer(p: ProgrammableTransferParams): Tx {
  const transfer = p.cip113.transfer;
  if (!transfer) throw new Cip113TransferError('no CIP-113 transfer params configured for this network');
  if (!/^[0-9a-f]{56}[0-9a-f]*$/i.test(p.unit)) throw new Cip113TransferError('malformed asset unit');
  if (p.quantity <= 0n) throw new Cip113TransferError('quantity must be greater than zero');

  const policyId = p.unit.slice(0, 56).toLowerCase();

  // The registry node is the on-chain truth for this policy's transfer logic; everything configured
  // must match it. (The node itself was NFT-authenticated by findRegistryNode.)
  if (p.registryNode.node.key !== policyId) {
    throw new Cip113TransferError('registry node does not belong to this policy');
  }
  const transferLogicHash = p.registryNode.node.transferLogicScript.hash;
  const transferLogicHex = transfer.scripts.transferLogic[policyId];
  if (!transferLogicHex) {
    throw new Cip113TransferError(`no transfer-logic script configured for policy ${policyId}`);
  }

  const baseScript = verifiedScript(transfer.scripts.base, p.cip113.programmableLogicBase, 'programmable-logic-base');
  const globalScript = verifiedScript(transfer.scripts.global, transfer.programmableLogicGlobal, 'global');
  const transferLogicScript = verifiedScript(transferLogicHex, transferLogicHash, 'transfer-logic');

  // Enough tokens at the source?
  const available = quantityOf(p.sourceUtxos, p.unit);
  if (available < p.quantity) {
    throw new Cip113TransferError(`insufficient programmable tokens (have ${available}, sending ${p.quantity})`);
  }
  const remainder = available - p.quantity;

  const recipientAddr = recipientProgrammableAddress(p.cip113, p.recipientBaseAddress, p.network);
  const outputLovelace = p.outputLovelace ?? 2_000_000n;

  // Reference inputs in a FIXED order: [registry node, protocol params] — the TransferAct proof
  // indexes the registry node inside this list, and a postcondition below re-checks the built tx.
  const refInputs = [p.registryNodeUtxo, p.protocolParamsUtxo];
  const nodeIdx = 0;

  // Withdraw-zero invocations. Reward accounts are built as full StakeAddresses so the NETWORK byte
  // is explicit (cardano-ledger-ts defaults bare hashes to mainnet — wrong everywhere but mainnet).
  const withdrawZero = (scriptHash: string, script: Script, redeemer: Data) => ({
    withdrawal: {
      rewardAccount: new StakeAddress({
        network: p.network,
        credentials: new StakeValidatorHash(scriptHash),
        type: 'script' as const,
      }),
      amount: 0,
    },
    script: { inline: script, redeemer },
  });

  // Datum handling (upstream-undocumented): PRESERVE the first source UTxO's inline datum on the
  // programmable outputs, if any — the most conservative choice until the substandard specifies one.
  const sourceDatum = p.sourceUtxos[0]?.resolved.datum;
  const preservedDatum = sourceDatum !== undefined && !(sourceDatum instanceof Uint8Array) ? sourceDatum : undefined;

  const tokenValue = (qty: bigint) =>
    Value.fromUnits([
      { unit: 'lovelace', quantity: outputLovelace.toString() },
      { unit: p.unit.toLowerCase(), quantity: qty.toString() },
    ]);

  // Funding SELECTION: `fundingUtxos` is a candidate pool — spending it wholesale would consolidate
  // the entire wallet through one Plutus tx (observed live: a 1-token transfer swept 7000+ ADA and
  // every other asset into a single change output — privacy loss, every UTxO locked while pending,
  // inflated fee). Select ADA-only candidates first so no unrelated token ever rides through the
  // programmable transfer; fall back to token-carrying UTxOs only if the ADA-only pool can't cover.
  // Needed lovelace beyond what the source UTxOs bring: the programmable outputs' min-ADA (the
  // selection buffer inside selectInputs covers fee + ADA-change min-ADA).
  const sourceLovelace = p.sourceUtxos.reduce((s, u) => s + u.resolved.value.lovelaces, 0n);
  const outputCount = remainder > 0n ? 2n : 1n;
  const neededLovelace = outputLovelace * outputCount - sourceLovelace;
  const fundingTarget = { lovelace: neededLovelace > 0n ? neededLovelace : 0n };
  const adaOnlyCandidates = p.fundingUtxos.filter((u) => valueView(u.resolved.value).assets.length === 0);
  let funding: UTxO[];
  try {
    funding = selectInputs(adaOnlyCandidates, fundingTarget);
  } catch {
    try {
      funding = selectInputs(p.fundingUtxos, fundingTarget); // last resort — pool too poor in ADA-only
    } catch {
      throw new Cip113TransferError('insufficient regular wallet funds for fee/min-ADA of the transfer');
    }
  }

  const tb = new TxBuilder(p.protocolParameters, p.genesisInfos);
  const buildArgs = {
    inputs: [
      // Script spends: each source UTxO unlocks via the base validator (redeemer ignored upstream).
      ...p.sourceUtxos.map((utxo) => ({
        utxo,
        inputScript: { script: baseScript, redeemer: unitRedeemer() },
      })),
      ...funding.map((utxo) => ({ utxo })),
    ],
    readonlyRefInputs: refInputs,
    outputs: [
      {
        address: Address.fromString(recipientAddr),
        value: tokenValue(p.quantity),
        ...(preservedDatum !== undefined ? { datum: preservedDatum } : {}),
      },
      // Token change stays at the SENDER's programmable address — never a regular address.
      ...(remainder > 0n
        ? [
            {
              address: Address.fromString(p.senderProgrammableAddress),
              value: tokenValue(remainder),
              ...(preservedDatum !== undefined ? { datum: preservedDatum } : {}),
            },
          ]
        : []),
    ],
    withdrawals: [
      withdrawZero(transfer.programmableLogicGlobal, globalScript, transferActRedeemer(nodeIdx)),
      withdrawZero(transferLogicHash, transferLogicScript, unitRedeemer()),
    ],
    requiredSigners: [p.senderStakeKeyHash],
    collaterals: [p.collateral],
    changeAddress: p.changeAddress,
  };

  // Two-pass fee: buildooor's minFee estimation does not account for the vkey witnesses that
  // `requiredSigners` entries will add (observed live on preview: supplied 228189 < expected 230432
  // → FeeTooSmallUTxO). Build once to get its estimate, then rebuild with an explicit fee that also
  // covers one full vkey witness (~102 CBOR bytes) per required signer. Slight over-payment
  // (≤ ~0.005 ADA) is deterministic and beats a node rejection.
  const draft = tb.buildSync(buildArgs);
  const witnessBytesPerSigner = 102n;
  const feePerByte = BigInt(p.protocolParameters.txFeePerByte ?? 44);
  const fee = draft.body.fee + witnessBytesPerSigner * feePerByte * BigInt(buildArgs.requiredSigners.length);
  const tx = tb.buildSync({ ...buildArgs, fee });

  assertTransferPostconditions(tx, p, refInputs, nodeIdx, transfer);
  return tx;
}

/**
 * Postconditions on the BUILT tx — the builder library is free to normalize/reorder, and a silently
 * shifted index or dropped withdrawal would make the user sign a tx that can only fail (or worse,
 * validate against the wrong proof). Throw instead of returning anything signable.
 */
function assertTransferPostconditions(
  tx: Tx,
  p: ProgrammableTransferParams,
  refInputs: UTxO[],
  nodeIdx: number,
  transfer: Cip113TransferParams,
): void {
  // 1. The registry node sits at exactly the index the TransferAct proof claims.
  const nodeUtxo = refInputs[nodeIdx];
  if (!nodeUtxo) throw new Cip113TransferError('internal: missing registry-node reference input');
  const builtRefs = (tx.body.refInputs ?? []).map((u) => u.utxoRef.toString());
  if (builtRefs[nodeIdx] !== forceTxOutRef(nodeUtxo.utxoRef).toString()) {
    throw new Cip113TransferError(
      `reference inputs were reordered by the builder (registry node expected at ${nodeIdx}) — aborting`,
    );
  }
  // 2. Both withdraw-zero invocations survived, with amount 0.
  const w = tx.body.withdrawals?.map;
  const accounts = new Set((w ?? []).map((e) => e.rewardAccount.credentials.toString()));
  if (
    (w ?? []).length < 2 ||
    !accounts.has(transfer.programmableLogicGlobal) ||
    !accounts.has(p.registryNode.node.transferLogicScript.hash) ||
    (w ?? []).some((e) => e.amount !== 0n)
  ) {
    throw new Cip113TransferError('a required withdraw-zero invocation is missing from the built tx — aborting');
  }
  // 3. Programmable tokens appear ONLY on programmable-address outputs (base-script payment part).
  const policyId = p.unit.slice(0, 56).toLowerCase();
  for (const out of tx.body.outputs) {
    const valueJson = (out.value as unknown as { toJson(): ValueJson }).toJson();
    const carries = Object.keys(valueJson[policyId] ?? {}).length > 0;
    if (carries && out.address.paymentCreds.hash.toString() !== p.cip113.programmableLogicBase) {
      throw new Cip113TransferError('programmable tokens routed to a non-programmable address — aborting');
    }
  }
}
