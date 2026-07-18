// Local signer (EXECUTION_PLAN T3.2). Runs ONLY in the privileged background, only after the user
// approved the decoded summary (CLAUDE.md §1.4). Adds vkey witnesses to an unsigned tx and returns
// the signed CBOR. CAUTION: ledger-ts 0.5.6's `signWith` signs with EVERY key it is handed (0.5.1
// filtered to required signers) — callers must pass a curated key set: input-owner keys plus
// conwayRequiredKeyHashes-matched stake/DRep keys, never "offer everything".
import { Tx, TxWitnessSet, type XPrv } from '@harmoniclabs/buildooor';
import { toHex } from '../core/crypto/encoding';

export function signTxCbor(txCbor: string, keys: XPrv[]): string {
  const tx = Tx.fromCbor(txCbor);
  for (const key of keys) tx.signWith(key);
  return toHex(tx.toCborBytes());
}

/**
 * CIP-30 signTx: return ONLY the witness set with the vkey witnesses we added (not the whole tx).
 * The dApp merges this with its transaction. We slice off any witnesses the dApp's tx already carried.
 */
export function signTxWitnessSet(txCbor: string, keys: XPrv[]): string {
  const tx = Tx.fromCbor(txCbor);
  const before = tx.witnesses.vkeyWitnesses?.length ?? 0;
  for (const key of keys) tx.signWith(key);
  const added = (tx.witnesses.vkeyWitnesses ?? []).slice(before);
  return toHex(new TxWitnessSet({ vkeyWitnesses: added }).toCborBytes());
}
