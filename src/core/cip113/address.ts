// CIP-113 programmable-token address computation (EXECUTION_PLAN T9.2). All programmable tokens sit
// at base addresses whose PAYMENT part is the shared programmable-logic-base script hash; OWNERSHIP
// is the stake-credential slot: addr(programmable_logic_base, owner_credential). To see the user's
// programmable balance we therefore compute that address for the wallet's own credentials and query
// its UTxOs — the inverse of normal discovery, where the payment credential is ours.
//
// Pure & framework-free (buildooor only). No keys are handled here — callers pass 28-byte key HASHES.
import { Address, Credential, StakeCredentials } from '@harmoniclabs/buildooor';
import type { Network } from '../address';
import type { Cip113Params } from './params';

/**
 * The programmable-token address owned by `ownerKeyHash` (a 28-byte blake2b_224 key hash): shared
 * script payment credential + the owner's key-hash stake credential.
 */
export function programmableTokenAddress(
  programmableLogicBase: string,
  ownerKeyHash: Uint8Array,
  network: Network,
): string {
  const pay = Credential.script(programmableLogicBase);
  const owner = StakeCredentials.keyHash(ownerKeyHash);
  const addr = network === 'mainnet' ? Address.mainnet(pay, owner) : Address.testnet(pay, owner);
  return addr.toString();
}

/**
 * All programmable-token addresses that could hold this wallet's tokens, deduped. Per the upstream
 * integration guide the owner credential is the holder's STAKE key hash by convention, but issuers
 * may use the PAYMENT key hash instead (enterprise/CEX wallets without stake credentials) — so we
 * query both and merge. Both hashes are for account 0 of this wallet.
 */
export function ownProgrammableAddresses(
  params: Cip113Params,
  owner: { stakeKeyHash: Uint8Array; paymentKeyHash: Uint8Array },
  network: Network,
): string[] {
  const addrs = [
    programmableTokenAddress(params.programmableLogicBase, owner.stakeKeyHash, network),
    programmableTokenAddress(params.programmableLogicBase, owner.paymentKeyHash, network),
  ];
  return [...new Set(addrs)];
}
