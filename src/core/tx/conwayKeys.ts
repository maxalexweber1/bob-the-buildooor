// Which key hashes — beyond input ownership — does a tx require signatures from? (T6.2/CIP-95)
//  - certificates: each cert declares its authorizing signers via getRequiredSigners() (stake key
//    for registrations/delegations, DRep key for DRep registration/update, pool key for pool certs);
//  - reward withdrawals: the reward account's KEY credential (script accounts are script-witnessed);
//  - governance votes (CIP-1694): key-hash voters (CC hot key, DRep key, SPO cold key).
//
// WHY this exists: cardano-ledger-ts 0.5.6's `Tx.signWith` signs UNCONDITIONALLY with every key it
// is handed (0.5.1 attached a witness only for required signers). The signer must therefore be given
// a curated key set — a wallet must never emit a signature the tx doesn't need (gratuitous stake or
// DRep signatures leak key usage on-chain and inflate the tx past its computed fee).
//
// Pure & framework-free; returns lowercase hex hashes for set-membership tests against toHex output.
import { VoterKind, type Certificate, type Tx } from '@harmoniclabs/buildooor';

/** Voter kinds whose vote is authorized by a plain vkey signature (the script variants are not). */
const KEY_VOTER_KINDS: ReadonlySet<VoterKind> = new Set([
  VoterKind.ConstitutionalCommitteKeyHash,
  VoterKind.DRepKeyHash,
  VoterKind.StakingPoolKeyHash,
]);

/** Key hashes (lowercase hex) required by certificates, withdrawals and votes in this tx. */
export function conwayRequiredKeyHashes(tx: Tx): Set<string> {
  const out = new Set<string>();

  for (const cert of (tx.body.certs ?? []) as Certificate[]) {
    for (const h of cert.getRequiredSigners()) out.add(h.toString().toLowerCase());
  }

  for (const w of tx.body.withdrawals?.map ?? []) {
    // Script reward accounts are witnessed by their script, never a vkey.
    if (w.rewardAccount.type !== 'script') {
      out.add(w.rewardAccount.credentials.toString().toLowerCase());
    }
  }

  for (const entry of tx.body.votingProcedures?.procedures ?? []) {
    if (KEY_VOTER_KINDS.has(entry.voter.kind)) {
      out.add(entry.voter.hash.toString().toLowerCase());
    }
  }

  return out;
}
