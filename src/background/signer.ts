// Local signer (EXECUTION_PLAN T3.2). Runs ONLY in the privileged background, only after the user
// approved the decoded summary (CLAUDE.md §1.4). Adds vkey witnesses to an unsigned tx and returns
// the signed CBOR. buildooor's `signWith` adds a witness only for keys that are required signers, so
// passing the precise input-owner keys is sufficient (and extra keys would be harmless).
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
