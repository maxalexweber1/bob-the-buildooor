// Address assembly (EXECUTION_PLAN T1.4). Pure & framework-free: builds CIP-1852 base addresses
// from a BIP32-Ed25519 root key via buildooor. No chrome.*, no key persistence (that's the vault's job).
import {
  type XPrv,
  Address,
  Credential,
  StakeCredentials,
  StakeAddress,
  StakeKeyHash,
  blake2b_224,
} from '@harmoniclabs/buildooor';
import { deriveKey, deriveAccountKey, deriveFromAccount, Role } from './keys';

export type Network = 'mainnet' | 'testnet';

/** Bech32 address network for a chain network — preview & preprod both use the `addr_test` prefix. */
export function bech32Network(chain: 'mainnet' | 'preview' | 'preprod'): Network {
  return chain === 'mainnet' ? 'mainnet' : 'testnet';
}

/** Payment chains that produce a spendable base address: external (receive) or internal (change). */
export type PaymentRole = typeof Role.External | typeof Role.Internal;

/** blake2b_224 (28-byte) hash of raw Ed25519 public-key bytes — a Cardano key hash. */
export function keyHash28(pubKeyBytes: Uint8Array): Uint8Array {
  return blake2b_224(pubKeyBytes);
}

/** Payment key-hash credential for m/1852'/1815'/account'/role/index (role 0=external, 1=change). */
export function paymentCredential(
  root: XPrv,
  account: number,
  index: number,
  role: PaymentRole = Role.External,
): Credential {
  const pk = deriveKey(root, account, role, index).public().toPubKeyBytes();
  return Credential.keyHash(keyHash28(pk));
}

/** Staking key-hash credential for m/1852'/1815'/account'/2/0 — one stake key per account. */
export function stakeCredential(root: XPrv, account: number): StakeCredentials {
  const pk = deriveKey(root, account, Role.Staking, 0).public().toPubKeyBytes();
  return StakeCredentials.keyHash(keyHash28(pk));
}

/**
 * Reusable per-account derivation context: the account-level XPrv + the (shared) stake credential.
 * Build once with `accountKeys`, then derive many addresses cheaply via `baseAddressFrom` — avoids
 * re-deriving the `1852'/1815'/account'` prefix and the stake key per address (expensive in buildooor).
 */
export interface AccountKeys {
  accountKey: XPrv;
  stakeCredential: StakeCredentials;
  /** blake2b_224 of the stake public key — reused to build the reward (stake) address. */
  stakeKeyHash: Uint8Array;
}

export function accountKeys(root: XPrv, account = 0): AccountKeys {
  const accountKey = deriveAccountKey(root, account);
  const stakePk = deriveFromAccount(accountKey, Role.Staking, 0).public().toPubKeyBytes();
  const stakeKeyHash = keyHash28(stakePk);
  return { accountKey, stakeCredential: StakeCredentials.keyHash(stakeKeyHash), stakeKeyHash };
}

/** Reward (stake) address for the account — CIP-30 getRewardAddresses (returns hex of its bytes). */
export function rewardAddress(keys: AccountKeys, network: Network): StakeAddress {
  return new StakeAddress({ network, credentials: new StakeKeyHash(keys.stakeKeyHash), type: 'stakeKey' });
}

/** Raw Ed25519 DRep public key — CIP-105 path `…/3/0`, used by CIP-95 getPubDRepKey. */
export function drepPublicKey(keys: AccountKeys): Uint8Array {
  return deriveFromAccount(keys.accountKey, Role.DRep, 0).public().toPubKeyBytes();
}

/** Raw Ed25519 stake public key — `…/2/0`, used by CIP-95 get{Un}registeredPubStakeKeys. */
export function stakePublicKey(keys: AccountKeys): Uint8Array {
  return deriveFromAccount(keys.accountKey, Role.Staking, 0).public().toPubKeyBytes();
}

/** Base address for `index` on the given `role` chain, reusing a precomputed `AccountKeys`. */
export function baseAddressFrom(
  keys: AccountKeys,
  network: Network,
  index: number,
  role: PaymentRole = Role.External,
): string {
  const pk = deriveFromAccount(keys.accountKey, role, index).public().toPubKeyBytes();
  const pay = Credential.keyHash(keyHash28(pk));
  const addr = network === 'mainnet' ? Address.mainnet(pay, keys.stakeCredential) : Address.testnet(pay, keys.stakeCredential);
  return addr.toString();
}

/**
 * CIP-1852 base address (payment + stake) as bech32: `addr1…` (mainnet) / `addr_test1…` (testnet).
 * `role` selects the external (receive) or internal (change) payment chain; the stake part is shared.
 */
export function baseAddress(
  root: XPrv,
  network: Network,
  account = 0,
  index = 0,
  role: PaymentRole = Role.External,
): string {
  const pay = paymentCredential(root, account, index, role);
  const stake = stakeCredential(root, account);
  const addr = network === 'mainnet' ? Address.mainnet(pay, stake) : Address.testnet(pay, stake);
  return addr.toString();
}
