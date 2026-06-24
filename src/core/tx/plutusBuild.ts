// Plutus spend building (EXECUTION_PLAN T5.2/T5.3). Builds a transaction that spends a UTxO locked
// at a Plutus validator: validator script + redeemer (+ datum for V1/V2), ADA-only collateral, and
// funding inputs for fees/min-ada. buildooor runs the local CEK with the provided cost models and
// computes the scriptDataHash.
//
// Authoritative ex-units come from a second pass against Ogmios (`evaluatePlutusTx`) — verified live
// against a Conway node: a build with the node's real cost models passes evaluateTransaction without
// PPViewHashesDontMatch. ALWAYS pass real cost models (OgmiosProvider.getProtocolParameters) — the
// buildooor default cost models do NOT match the chain and produce an unspendable scriptDataHash.
import {
  Address,
  TxBuilder,
  Value,
  type Data,
  type GenesisInfos,
  type ProtocolParameters,
  type Script,
  type Tx,
  type UTxO,
} from '@harmoniclabs/buildooor';

export interface PlutusSpendParams {
  protocolParameters: ProtocolParameters; // MUST carry real cost models (see file header)
  genesisInfos: GenesisInfos;
  /** The UTxO sitting at the validator's script address. */
  scriptUtxo: UTxO;
  /** Inline validator script. Provide this OR `referenceScriptUtxo` (CIP-33), not both. */
  script?: Script;
  /** A UTxO carrying the validator as a reference script (CIP-33) — spends without inlining it. */
  referenceScriptUtxo?: UTxO;
  redeemer: Data;
  /** Datum for the script input. Omit for a datum-less Plutus V3 UTxO. */
  datum?: Data;
  /** ADA-only collateral UTxO (forfeited only if phase-2 validation fails). */
  collateral: UTxO;
  /** Extra wallet UTxOs to fund fees / min-ada beyond the script UTxO's value. */
  fundingUtxos: UTxO[];
  /** Read-only reference inputs (CIP-31): datums/values read by the validator without being spent. */
  referenceInputs?: UTxO[];
  outputs: Array<{ toAddress: string; lovelace: bigint }>;
  changeAddress: string;
}

export function buildPlutusSpend(p: PlutusSpendParams): Tx {
  const tb = new TxBuilder(p.protocolParameters, p.genesisInfos);

  // The validator comes either inline (`inputScript`) or from a reference UTxO (`referenceScript`, CIP-33).
  let scriptInput: { utxo: UTxO; inputScript?: object; referenceScript?: object };
  if (p.referenceScriptUtxo) {
    scriptInput = {
      utxo: p.scriptUtxo,
      referenceScript: { refUtxo: p.referenceScriptUtxo, redeemer: p.redeemer, ...(p.datum !== undefined ? { datum: p.datum } : {}) },
    };
  } else if (p.script) {
    scriptInput = {
      utxo: p.scriptUtxo,
      inputScript: { script: p.script, redeemer: p.redeemer, ...(p.datum !== undefined ? { datum: p.datum } : {}) },
    };
  } else {
    throw new Error('buildPlutusSpend: provide either `script` or `referenceScriptUtxo`');
  }

  return tb.buildSync({
    inputs: [scriptInput, ...p.fundingUtxos.map((utxo) => ({ utxo }))],
    collaterals: [p.collateral],
    ...(p.referenceInputs && p.referenceInputs.length > 0 ? { readonlyRefInputs: p.referenceInputs } : {}),
    outputs: p.outputs.map((o) => ({ address: Address.fromString(o.toAddress), value: Value.lovelaces(o.lovelace) })),
    changeAddress: p.changeAddress,
  });
}

/** Deploy a reference script (CIP-33): an output carrying the validator, spendable later via reference.
 *  Inflates the output's min-ADA (the script bytes count) — fund `lovelace` accordingly. */
export function buildDeployRefScript(p: {
  protocolParameters: ProtocolParameters;
  genesisInfos: GenesisInfos;
  script: Script;
  atAddress: string;
  lovelace: bigint;
  fundingUtxos: UTxO[];
  changeAddress: string;
}): Tx {
  const tb = new TxBuilder(p.protocolParameters, p.genesisInfos);
  return tb.buildSync({
    inputs: p.fundingUtxos.map((utxo) => ({ utxo })),
    outputs: [{ address: Address.fromString(p.atAddress), value: Value.lovelaces(p.lovelace), refScript: p.script }],
    changeAddress: p.changeAddress,
  });
}

export interface PlutusMintParams {
  protocolParameters: ProtocolParameters; // MUST carry real cost models
  genesisInfos: GenesisInfos;
  /** The minting policy script (its hash is the policy id). */
  policy: Script;
  redeemer: Data;
  /** Assets to mint/burn under the policy (negative quantity burns). */
  mint: Array<{ nameHex: string; quantity: bigint }>;
  /** Where minted tokens are sent. */
  toAddress: string;
  /** Min-ADA to attach to the mint output (tokens can't sit alone). */
  outputLovelace?: bigint;
  collateral: UTxO;
  fundingUtxos: UTxO[];
  changeAddress: string;
}

export function buildPlutusMint(p: PlutusMintParams): Tx {
  const tb = new TxBuilder(p.protocolParameters, p.genesisInfos);
  const policyId = p.policy.hash.toString();
  const units = [
    { unit: 'lovelace', quantity: (p.outputLovelace ?? 2_000_000n).toString() },
    ...p.mint.map((a) => ({ unit: policyId + a.nameHex, quantity: a.quantity.toString() })),
  ];

  return tb.buildSync({
    inputs: p.fundingUtxos.map((utxo) => ({ utxo })),
    mints: [
      {
        value: { policy: p.policy.hash, assets: p.mint.map((a) => ({ name: a.nameHex, quantity: a.quantity })) },
        script: { inline: p.policy, redeemer: p.redeemer },
      },
    ],
    outputs: [{ address: Address.fromString(p.toAddress), value: Value.fromUnits(units) }],
    collaterals: [p.collateral],
    changeAddress: p.changeAddress,
  });
}

/** Provider that can evaluate scripts (Ogmios). */
interface Evaluator {
  evaluateTx?(txCbor: string): Promise<Array<{ validator: { purpose: string; index: number }; budget: { memory: number; cpu: number } }>>;
}

// EX-UNITS: buildooor computes them via its own CEK machine (iterating `nScriptExecutionRounds` to
// converge) using the provided cost models. With the chain's real cost models these match on-chain —
// verified live (spend, mint, ref-script-spend all confirmed on preview). So we don't "stamp" external
// units; `evaluatePlutusTx` against Ogmios is an OPTIONAL cross-check, not required for correctness.

/** Pass 2 (optional verification): per-redeemer ex-units from the node. Null if the provider can't eval. */
export async function evaluatePlutusTx(
  provider: Evaluator,
  txCborHex: string,
): Promise<Array<{ validator: { purpose: string; index: number }; budget: { memory: number; cpu: number } }> | null> {
  if (!provider.evaluateTx) return null;
  return provider.evaluateTx(txCborHex);
}
