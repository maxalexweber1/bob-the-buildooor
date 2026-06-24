// Human-readable transaction summary (EXECUTION_PLAN T3.3) — the anti-blind-signing decoder.
// CLAUDE.md §1.5: an approval UI must NEVER show an opaque CBOR blob; it must render what the tx
// actually does. This turns a buildooor Tx + its resolved inputs into {inputs, outputs, fee}.
// Reusable for our own sends (M3) and, later, dApp-provided txs (M4) where inputs are provider-resolved.
import type { Tx, UTxO } from '@harmoniclabs/buildooor';
import { valueView, type TokenBundle } from '../balance';

export interface TxIO {
  address: string;
  value: TokenBundle;
}

/**
 * Presence flags for tx-body components we don't fully decode yet (mint, certs, governance, …). The
 * approval UI WARNS when any is set, so a malicious/buggy dApp can't slip a mint or certificate past
 * the user just because we only render inputs/outputs/fee (CLAUDE.md §1.5 — never blind-sign).
 */
export interface TxFlags {
  mint: boolean;
  certificates: boolean;
  withdrawals: boolean;
  metadata: boolean;
  governance: boolean;
  requiredSigners: boolean;
}

export interface TxSummary {
  inputs: TxIO[];
  outputs: Array<TxIO & { isOwn: boolean }>;
  /** Inputs we couldn't resolve to a known UTxO (shown so nothing is hidden from the user). */
  unresolvedInputs: number;
  fee: string;
  flags: TxFlags;
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
  const flags: TxFlags = {
    mint: present(b.mint),
    certificates: present(b.certs),
    withdrawals: present(b.withdrawals),
    metadata: present(b.auxDataHash),
    governance: present(b.votingProcedures) || present(b.proposalProcedures),
    requiredSigners: present(b.requiredSigners),
  };

  return { inputs, outputs, unresolvedInputs, fee: tx.body.fee.toString(), flags };
}

/** A tx-body field is "present" if set and (for collections) non-empty. Over-warns rather than hide. */
function present(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}
