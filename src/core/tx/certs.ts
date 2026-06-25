// Conway / Shelley certificate + governance decoding for the approval UI (T6.2). The wallet must show
// WHAT a governance tx actually does before signing (CLAUDE.md §1.5 — never blind-sign): "Delegate
// voting power to DRep X", "Register as a DRep", "Delegate stake to pool Y", etc. — not a bare flag.
//
// Pure & framework-free: operates on a certificate's `toJson()` (buildooor `Cert*.toJson()` →
// `{ certType, … }`) and on plain counts, so it is unit-testable without building a full tx (which the
// installed buildooor can't yet do for Conway certs — see docs notes). No chrome.*, no buildooor import.

export interface CertView {
  /** Certificate type name, e.g. "VoteDeleg", "RegistrationDrep", "StakeDelegation". */
  type: string;
  /** Human-readable one-line description rendered in the approval. */
  description: string;
}

export interface GovernanceView {
  /** Voting procedures are present (DRep/SPO/CC votes). Not decoded in detail in this build. */
  hasVotes: boolean;
  /** Number of governance proposals (CIP-1694) the tx submits. */
  proposals: number;
}

/** lovelace (string|number|bigint) → a short "N ₳" string; falls back to raw on parse failure. */
function ada(lovelace: unknown): string {
  try {
    const l = BigInt(lovelace as string | number | bigint);
    const whole = l / 1_000_000n;
    const frac = (l % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return `${whole}${frac ? '.' + frac : ''} ₳`;
  } catch {
    return `${String(lovelace)} lovelace`;
  }
}

function short(hash: unknown): string {
  return typeof hash === 'string' && hash.length > 16 ? `${hash.slice(0, 12)}…` : String(hash ?? '?');
}

/** Describe a DRep target (the `drep` field of a vote-delegation cert). */
function describeDrep(drep: unknown): string {
  const d = (drep ?? {}) as Record<string, unknown>;
  switch (d.drepType) {
    case 'AlwaysAbstain':
      return 'Always Abstain';
    case 'AlwaysNoConfidence':
      return 'Always No Confidence';
    case 'KeyHash':
    case 'Script':
      return `DRep ${short(d.hash)}`;
    default:
      return 'a DRep';
  }
}

/** Map one certificate's JSON to a `CertView`. Unknown types degrade to a generic, honest label. */
export function certView(json: unknown): CertView {
  const o = (json ?? {}) as Record<string, unknown>;
  const type = typeof o.certType === 'string' ? o.certType : 'Unknown';
  const deposit = o.coin !== undefined ? ` (deposit ${ada(o.coin)})` : '';
  const refund = o.coin !== undefined ? ` (refund ${ada(o.coin)})` : '';
  let description: string;
  switch (type) {
    case 'VoteDeleg':
      description = `Delegate voting power to ${describeDrep(o.drep)}`;
      break;
    case 'StakeVoteDeleg':
      description = `Delegate stake to pool ${short(o.poolKeyHash)} and voting power to ${describeDrep(o.drep)}`;
      break;
    case 'VoteRegistrationDeleg':
      description = `Register stake key${deposit} and delegate voting power to ${describeDrep(o.drep)}`;
      break;
    case 'StakeVoteRegistrationDeleg':
      description = `Register stake key${deposit}, delegate stake to pool ${short(o.poolKeyHash)} and voting power to ${describeDrep(o.drep)}`;
      break;
    case 'RegistrationDrep':
      description = `Register as a DRep${deposit}`;
      break;
    case 'UnRegistrationDrep':
      description = `Retire DRep${refund}`;
      break;
    case 'UpdateDrep':
      description = 'Update DRep metadata';
      break;
    case 'StakeRegistration':
    case 'RegistrationDeposit':
      description = `Register stake key${deposit}`;
      break;
    case 'StakeDeRegistration':
    case 'UnRegistrationDeposit':
      description = `Deregister stake key${refund}`;
      break;
    case 'StakeDelegation':
    case 'StakeRegistrationDeleg':
      description = `Delegate stake to pool ${short(o.poolKeyHash)}`;
      break;
    case 'AuthCommitteeHot':
      description = 'Authorize a constitutional-committee hot key';
      break;
    case 'ResignCommitteeCold':
      description = 'Resign from the constitutional committee';
      break;
    default:
      description = `Certificate: ${type}`;
  }
  return { type, description };
}

/** Decode the tx body's certificates into display views. */
export function decodeCerts(certs: ReadonlyArray<{ toJson(): unknown }> | undefined): CertView[] {
  if (!certs) return [];
  return certs.map((c) => certView(c.toJson()));
}

/** Decode governance presence: voting procedures (flag) + proposal count. */
export function decodeGovernance(
  votingProcedures: unknown,
  proposalProcedures: ArrayLike<unknown> | undefined,
): GovernanceView {
  return {
    hasVotes: votingProcedures !== undefined && votingProcedures !== null,
    proposals: proposalProcedures?.length ?? 0,
  };
}
