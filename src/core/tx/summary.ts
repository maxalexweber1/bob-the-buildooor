// Human-readable transaction summary (EXECUTION_PLAN T3.3) — the anti-blind-signing decoder.
// CLAUDE.md §1.5: an approval UI must NEVER show an opaque CBOR blob; it must render what the tx
// actually does. This turns a buildooor Tx + its resolved inputs into {inputs, outputs, fee}.
// Reusable for our own sends (M3) and, later, dApp-provided txs (M4) where inputs are provider-resolved.
import type { Tx, UTxO } from '@harmoniclabs/buildooor';
import { valueView, type TokenBundle, type AssetBalance } from '../balance';
import { decodeTxMessage, CIP20_MESSAGE_LABEL, type TxMessage } from './txMessage';
import { decodeCerts, decodeGovernance, type CertView, type GovernanceView } from './certs';

export interface TxIO {
  address: string;
  value: TokenBundle;
}

/** A decoded reward withdrawal (CLAUDE.md §1.5 — surface the destination + amount, not a boolean). */
export interface WithdrawalView {
  /** bech32 reward (stake) address the rewards are withdrawn to. */
  rewardAddress: string;
  amount: string;
}

/**
 * Presence flags for tx-body components we can't yet decode in detail (certs/governance need Conway
 * support buildooor doesn't expose; required-signers are bare key hashes). The approval UI WARNS when
 * any is set so they can't slip past the user, even though mint/burn, withdrawals and the CIP-20
 * message are now decoded explicitly (CLAUDE.md §1.5 — never blind-sign).
 *
 * `metadata` here means "auxiliary data is present that we did NOT surface" — it is suppressed when
 * the only metadata is the CIP-20 memo we decoded (see `message`), but still set for any other label.
 */
export interface TxFlags {
  certificates: boolean;
  metadata: boolean;
  governance: boolean;
  requiredSigners: boolean;
}

/** One redeemer's node-authoritative ex-units (from Ogmios `evaluateTransaction`). */
export interface NodeEvalRedeemer {
  purpose: string; // spend | mint | publish | withdraw | vote | propose
  index: number;
  memory: number;
  cpu: number;
}

/**
 * Result of re-evaluating a (dApp-provided) Plutus tx against the user's OWN node before signing —
 * "verify against your node, not the dApp's word". `verified` = the node ran every script and these
 * are its authoritative ex-units; `unavailable` = no node connected, or the node couldn't evaluate
 * (e.g. can't resolve the inputs) — NOT a failure: the tx stays signable (submit re-evaluates anyway).
 */
export interface NodeEval {
  status: 'verified' | 'unavailable';
  redeemers: NodeEvalRedeemer[];
  message?: string;
}

export interface TxSummary {
  inputs: TxIO[];
  outputs: Array<TxIO & { isOwn: boolean }>;
  /** Inputs we couldn't resolve to a known UTxO (shown so nothing is hidden from the user). */
  unresolvedInputs: number;
  /**
   * Collateral inputs — forfeited if a Plutus script fails phase-2 validation. Wallet-owned ADA at
   * risk MUST be visible in the approval (CLAUDE.md §1.5), so these are
   * resolved and rendered as their own concept, never lumped in with spending inputs.
   */
  collateralInputs: Array<TxIO & { isOwn: boolean }>;
  /** Collateral inputs we couldn't resolve (still surfaced — the value at risk is then unknown). */
  unresolvedCollateralInputs: number;
  /** Babbage collateral-return output: what comes back if collateral IS forfeited. */
  collateralReturn?: TxIO & { isOwn: boolean };
  /** Babbage total-collateral (lovelace actually forfeited on script failure), when declared. */
  totalCollateral?: string;
  /** Reference inputs (CIP-31) as `txHash#index` refs — read-only, NOT spent. */
  referenceInputs: string[];
  fee: string;
  /** Decoded mint/burn — a negative quantity is a burn. Empty when the tx mints nothing. */
  mint: AssetBalance[];
  /** Decoded reward withdrawals. Empty when none. */
  withdrawals: WithdrawalView[];
  /** Decoded certificates (stake/governance, incl. Conway CIP-95). Empty when none. */
  certificates: CertView[];
  /** Decoded governance presence (votes flag + proposal count, CIP-1694). */
  governance: GovernanceView;
  /** Decoded CIP-20 message/memo (label 674), when the tx carries one. */
  message?: TxMessage;
  /** Node cross-check of the tx's Plutus scripts (set by the signer when the tx carries redeemers). */
  nodeEval?: NodeEval;
  flags: TxFlags;
}

type HasValueJson = Parameters<typeof valueView>[0];

/** Decode a mint field (a `Value`) into signed per-asset entries (negative = burn). */
export function decodeMint(mint: HasValueJson | undefined): AssetBalance[] {
  return mint ? valueView(mint).assets : [];
}

/** Decode reward withdrawals from their bech32-keyed JSON map. */
export function decodeWithdrawals(
  withdrawals: { toJson(): Record<string, string> } | undefined,
): WithdrawalView[] {
  if (!withdrawals) return [];
  return Object.entries(withdrawals.toJson()).map(([rewardAddress, amount]) => ({
    rewardAddress,
    amount,
  }));
}

/**
 * @param tx              the (unsigned) transaction
 * @param resolvedInputs  UTxOs that may back the tx's inputs (matched by output ref)
 * @param ownAddresses    wallet-owned addresses — outputs to these are flagged `isOwn` (change/self)
 */
export function summarizeTx(tx: Tx, resolvedInputs: UTxO[], ownAddresses: ReadonlySet<string>): TxSummary {
  const byRef = new Map(resolvedInputs.map((u) => [u.utxoRef.toString(), u]));

  const inputs: TxIO[] = [];
  let unresolvedInputs = 0;
  for (const inp of tx.body.inputs) {
    const u = byRef.get(inp.utxoRef.toString());
    if (u) inputs.push({ address: u.resolved.address.toString(), value: valueView(u.resolved.value) });
    else unresolvedInputs++;
  }

  const outputs = tx.body.outputs.map((o) => {
    const address = o.address.toString();
    return { address, value: valueView(o.value), isOwn: ownAddresses.has(address) };
  });

  const b = tx.body;

  // Collateral is resolved from the same byRef map — the caller resolves collateral refs alongside
  // spending inputs (collateral must never be approvable invisibly).
  const collateralInputs: Array<TxIO & { isOwn: boolean }> = [];
  let unresolvedCollateralInputs = 0;
  for (const inp of b.collateralInputs ?? []) {
    const u = byRef.get(inp.utxoRef.toString());
    if (u) {
      const address = u.resolved.address.toString();
      collateralInputs.push({ address, value: valueView(u.resolved.value), isOwn: ownAddresses.has(address) });
    } else unresolvedCollateralInputs++;
  }
  const collateralReturn = b.collateralReturn
    ? {
        address: b.collateralReturn.address.toString(),
        value: valueView(b.collateralReturn.value),
        isOwn: ownAddresses.has(b.collateralReturn.address.toString()),
      }
    : undefined;
  const totalCollateral = b.totCollateral !== undefined ? b.totCollateral.toString() : undefined;
  const referenceInputs = [...(b.refInputs ?? [])].map((u) => u.utxoRef.toString());
  const metadataJson = tx.auxiliaryData?.metadata?.toJson();
  const message = decodeTxMessage(metadataJson);
  // Warn about auxiliary data only when something beyond the decoded CIP-20 memo is present: another
  // metadata label, or non-metadata aux data (native/Plutus scripts → body has the hash but no
  // metadata JSON). Over-warns rather than hide (CLAUDE.md §1.5).
  const otherMetadataLabel =
    metadataJson !== undefined &&
    Object.keys(metadataJson).some((k) => k !== CIP20_MESSAGE_LABEL);
  const undecodedAuxData = present(b.auxDataHash) && (otherMetadataLabel || message === undefined);

  const flags: TxFlags = {
    certificates: present(b.certs),
    metadata: undecodedAuxData,
    governance: present(b.votingProcedures) || present(b.proposalProcedures),
    requiredSigners: present(b.requiredSigners),
  };

  return {
    inputs,
    outputs,
    unresolvedInputs,
    collateralInputs,
    unresolvedCollateralInputs,
    ...(collateralReturn ? { collateralReturn } : {}),
    ...(totalCollateral !== undefined ? { totalCollateral } : {}),
    referenceInputs,
    fee: b.fee.toString(),
    mint: decodeMint(b.mint),
    withdrawals: decodeWithdrawals(b.withdrawals),
    certificates: decodeCerts(b.certs as ReadonlyArray<{ toJson(): unknown }> | undefined),
    governance: decodeGovernance(b.votingProcedures, b.proposalProcedures as ArrayLike<unknown> | undefined),
    ...(message ? { message } : {}),
    flags,
  };
}

/** A tx-body field is "present" if set and (for collections) non-empty. Over-warns rather than hide. */
function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
