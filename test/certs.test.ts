import { describe, it, expect } from 'vitest';
import { certView, decodeCerts, decodeGovernance } from '../src/core/tx/certs';

// Fixtures are real buildooor `Cert*.toJson()` outputs (captured from the installed lib), so the
// decoder is pinned to the actual wire shapes even though a full Conway tx can't be built/parsed yet.
const cred = { credentialType: 'KeyHash', hash: '11'.repeat(28) };
const pool = '22'.repeat(28);

describe('certView — Conway/Shelley certificate decode (T6.2, anti-blind-sign)', () => {
  it('vote delegation to an abstain DRep', () => {
    expect(certView({ certType: 'VoteDeleg', stakeCredential: cred, drep: { drepType: 'AlwaysAbstain' } })).toEqual({
      type: 'VoteDeleg',
      description: 'Delegate voting power to Always Abstain',
    });
  });

  it('vote delegation to a key-hash DRep (hash shortened)', () => {
    const v = certView({ certType: 'VoteDeleg', stakeCredential: cred, drep: { drepType: 'KeyHash', hash: '33'.repeat(28) } });
    expect(v.description).toBe('Delegate voting power to DRep 333333333333…');
  });

  it('DRep registration / retirement show the deposit / refund in ADA', () => {
    expect(certView({ certType: 'RegistrationDrep', drepCredential: cred, coin: '500000000', anchor: null }).description).toBe(
      'Register as a DRep (deposit 500 ₳)',
    );
    expect(certView({ certType: 'UnRegistrationDrep', drepCredential: cred, coin: '500000000' }).description).toBe(
      'Retire DRep (refund 500 ₳)',
    );
  });

  it('stake registration and pool delegation', () => {
    expect(certView({ certType: 'StakeRegistration', stakeCredential: cred }).description).toBe('Register stake key');
    expect(certView({ certType: 'StakeDelegation', stakeCredential: cred, poolKeyHash: pool }).description).toBe(
      'Delegate stake to pool 222222222222…',
    );
  });

  it('unknown / malformed certs degrade to an honest label, never throw', () => {
    expect(certView({ certType: 'SomethingNew' })).toEqual({ type: 'SomethingNew', description: 'Certificate: SomethingNew' });
    expect(certView(null)).toEqual({ type: 'Unknown', description: 'Certificate: Unknown' });
    expect(certView({ certType: 'RegistrationDrep', coin: 'not-a-number' }).description).toContain('not-a-number lovelace');
  });
});

describe('decodeCerts', () => {
  it('maps a body cert array via toJson()', () => {
    const certs = [
      { toJson: () => ({ certType: 'StakeRegistration', stakeCredential: cred }) },
      { toJson: () => ({ certType: 'VoteDeleg', stakeCredential: cred, drep: { drepType: 'AlwaysNoConfidence' } }) },
    ];
    expect(decodeCerts(certs).map((c) => c.type)).toEqual(['StakeRegistration', 'VoteDeleg']);
    expect(decodeCerts(undefined)).toEqual([]);
  });
});

describe('decodeGovernance', () => {
  it('flags votes and counts proposals', () => {
    expect(decodeGovernance(undefined, undefined)).toEqual({ hasVotes: false, proposals: 0 });
    expect(decodeGovernance({ procedures: {} }, [{}, {}])).toEqual({ hasVotes: true, proposals: 2 });
  });
});
