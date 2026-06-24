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
  /** The validator script (e.g. Script.plutusV3(...)). */
  script: Script;
  redeemer: Data;
  /** Datum for the script input. Omit for a datum-less Plutus V3 UTxO. */
  datum?: Data;
  /** ADA-only collateral UTxO (forfeited only if phase-2 validation fails). */
  collateral: UTxO;
  /** Extra wallet UTxOs to fund fees / min-ada beyond the script UTxO's value. */
  fundingUtxos: UTxO[];
  outputs: Array<{ toAddress: string; lovelace: bigint }>;
  changeAddress: string;
}

export function buildPlutusSpend(p: PlutusSpendParams): Tx {
  const tb = new TxBuilder(p.protocolParameters, p.genesisInfos);
  const inputScript =
    p.datum !== undefined
      ? { script: p.script, redeemer: p.redeemer, datum: p.datum }
      : { script: p.script, redeemer: p.redeemer };

  return tb.buildSync({
    inputs: [{ utxo: p.scriptUtxo, inputScript }, ...p.fundingUtxos.map((utxo) => ({ utxo }))],
    collaterals: [p.collateral],
    outputs: p.outputs.map((o) => ({ address: Address.fromString(o.toAddress), value: Value.lovelaces(o.lovelace) })),
    changeAddress: p.changeAddress,
  });
}

/** Provider that can evaluate scripts (Ogmios). */
interface Evaluator {
  evaluateTx?(txCbor: string): Promise<Array<{ validator: { purpose: string; index: number }; budget: { memory: number; cpu: number } }>>;
}

/** Pass 2: authoritative per-redeemer ex-units from the node. Returns null if the provider can't eval. */
export async function evaluatePlutusTx(
  provider: Evaluator,
  txCborHex: string,
): Promise<Array<{ validator: { purpose: string; index: number }; budget: { memory: number; cpu: number } }> | null> {
  if (!provider.evaluateTx) return null;
  return provider.evaluateTx(txCborHex);
}
