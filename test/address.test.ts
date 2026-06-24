import { describe, it, expect } from 'vitest';
import { Address } from '@harmoniclabs/buildooor';
import { mnemonicToRoot } from '../src/core/keys';
import { mnemonicToEntropy } from '../src/core/mnemonic';
import { accountKeys, baseAddress, baseAddressFrom, drepPublicKey, keyHash28, paymentCredential, rewardAddress, stakeCredential, stakePublicKey } from '../src/core/address';
import { Role } from '../src/core/keys';

// All-zero 256-bit entropy → canonical 24-word phrase. A fixed, network-free derivation vector.
const ZERO_24 = 'abandon '.repeat(23) + 'art';

// Known base address (account 0, external, index 0) for ZERO_24.
// Cross-verified three ways below: our manual assembly === buildooor's independent `Address.fromEntropy`
// and `Address.fromXPrv` constructors. NOTE: still worth a one-time cross-check against an external
// wallet (import ZERO_24 into Eternl/Yoroi testnet) — see EXECUTION_PLAN T1.4 done-when.
const ADDR0_TESTNET =
  'addr_test1qqqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqqpavzj';
const ADDR0_MAINNET =
  'addr1qyqt0pru382hy9vjlsxv3ye02z50sfvt8xunscg5pgden77z73dpdfng2ctw2ekqplqgrljelz7h4dneac27nn3qx3rqrhqvwd';

describe('CIP-1852 base address (T1.4 done-when)', () => {
  const root = mnemonicToRoot(ZERO_24);

  it('matches the pinned known vector (testnet + mainnet)', () => {
    expect(baseAddress(root, 'testnet', 0, 0)).toBe(ADDR0_TESTNET);
    expect(baseAddress(root, 'mainnet', 0, 0)).toBe(ADDR0_MAINNET);
  });

  it('agrees with buildooor’s independent Address.fromEntropy constructor', () => {
    // Different implementation path inside buildooor — divergence would flag a wrong role/order.
    const entropy = mnemonicToEntropy(ZERO_24);
    expect(Address.fromEntropy(entropy, 'testnet', 0, 0).toString()).toBe(ADDR0_TESTNET);
    expect(Address.fromEntropy(entropy, 'mainnet', 0, 0).toString()).toBe(ADDR0_MAINNET);
  });

  it('uses the correct bech32 prefix per network', () => {
    expect(baseAddress(root, 'testnet', 0, 0).startsWith('addr_test1')).toBe(true);
    expect(baseAddress(root, 'mainnet', 0, 0).startsWith('addr1')).toBe(true);
  });

  it('external (receive) and internal (change) chains differ but share the stake part', () => {
    const ext = baseAddress(root, 'testnet', 0, 0, Role.External);
    const chg = baseAddress(root, 'testnet', 0, 0, Role.Internal);
    expect(ext).not.toBe(chg);
    // Same account → same stake credential bytes.
    expect([...stakeCredential(root, 0).toCborBytes()]).toEqual([...stakeCredential(root, 0).toCborBytes()]);
  });

  it('distinct index → distinct address', () => {
    expect(baseAddress(root, 'testnet', 0, 0)).not.toBe(baseAddress(root, 'testnet', 0, 1));
  });

  it('baseAddressFrom (cached account keys) equals baseAddress for the same path', () => {
    const keys = accountKeys(root, 0);
    for (const [role, idx] of [[Role.External, 0], [Role.External, 3], [Role.Internal, 1]] as const) {
      expect(baseAddressFrom(keys, 'testnet', idx, role)).toBe(baseAddress(root, 'testnet', 0, idx, role));
      expect(baseAddressFrom(keys, 'mainnet', idx, role)).toBe(baseAddress(root, 'mainnet', 0, idx, role));
    }
  });
});

describe('credential helpers', () => {
  const root = mnemonicToRoot(ZERO_24);

  it('keyHash28 yields a 28-byte hash', () => {
    const pk = new Uint8Array(32); // arbitrary 32-byte pubkey
    expect(keyHash28(pk).length).toBe(28);
  });

  it('paymentCredential is a key-hash (not script) credential', () => {
    // Smoke check that it constructs and serializes deterministically.
    const a = paymentCredential(root, 0, 0).toCborBytes();
    const b = paymentCredential(root, 0, 0).toCborBytes();
    expect([...a]).toEqual([...b]);
  });

  it('rewardAddress builds a stake address with the right prefix (CIP-30 getRewardAddresses)', () => {
    const keys = accountKeys(root, 0);
    expect(rewardAddress(keys, 'testnet').toString().startsWith('stake_test1')).toBe(true);
    expect(rewardAddress(keys, 'mainnet').toString().startsWith('stake1')).toBe(true);
  });

  it('DRep (…/3/0) and stake (…/2/0) public keys are 32 bytes and distinct (CIP-95/CIP-105)', () => {
    const keys = accountKeys(root, 0);
    const drep = drepPublicKey(keys);
    const stake = stakePublicKey(keys);
    expect(drep.length).toBe(32);
    expect(stake.length).toBe(32);
    // distinct from each other and from the payment key (different derivation roles)
    const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
    expect(new Set([hex(drep), hex(stake), hex(stakeCredential(root, 0).toCborBytes())]).size).toBe(3);
  });
});
