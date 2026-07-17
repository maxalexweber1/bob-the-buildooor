// CIP-113 protocol constants (EXECUTION_PLAN T9.1). Programmable tokens key on three per-network
// deployment constants: the shared programmable-logic-base script hash (the payment credential all
// holders share), the registry address (where RegistryNode UTxOs sit), and the registry-node NFT
// policy (the authenticity anchor for registry entries — policy = identity, same anti-spoof rule as
// ADA Handles in core/handle.ts).
//
// The Cardano Foundation reference implementation is R&D-grade and unaudited (IMPLEMENTATION_PLAN
// §14): its contracts — and therefore every one of these constants — may still change. So the
// built-in table ships EMPTY, and constants are supplied per network via the settings override
// (`WalletSettings.cip113Params`) for preview/preprod experiments. Mainnet entries must not be added
// until an audited upstream deployment publishes stable constants.
//
// Pure & framework-free; the network union is declared locally so core/ stays independent of the
// provider layer (same reasoning as core/handle.ts's injected lookup).

/** Chain networks CIP-113 params can be configured for (compatible with the provider `Network`). */
export type Cip113Network = 'mainnet' | 'preview' | 'preprod';

export interface Cip113Params {
  /** Script hash (28 bytes, 56 hex) of the shared programmable-logic-base payment credential. */
  programmableLogicBase: string;
  /** Bech32 address of the registry (`registry_spend`) — where RegistryNode UTxOs live. */
  registryAddress: string;
  /** Policy id (56 hex) of the registry-node authenticity NFTs (token name == the node's key). */
  registryNodePolicyId: string;
}

/**
 * Built-in per-network deployment constants. Intentionally empty: no audited CIP-113 deployment
 * exists yet (upstream is R&D). When one ships, add its constants here — testnets first.
 */
export const BUILTIN_CIP113_PARAMS: Partial<Record<Cip113Network, Cip113Params>> = {};

const HASH28_RE = /^[0-9a-f]{56}$/;

/** Structural + format validation for one params entry. Trust-no-input: these come from storage. */
export function isValidCip113Params(p: unknown, network: Cip113Network): p is Cip113Params {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  if (typeof o.programmableLogicBase !== 'string' || !HASH28_RE.test(o.programmableLogicBase)) return false;
  if (typeof o.registryNodePolicyId !== 'string' || !HASH28_RE.test(o.registryNodePolicyId)) return false;
  if (typeof o.registryAddress !== 'string') return false;
  // The registry address must belong to the configured network — a mainnet address configured for
  // preview (or vice versa) means the whole entry is a mistake; ignore it rather than query nonsense.
  const wantPrefix = network === 'mainnet' ? 'addr1' : 'addr_test1';
  return o.registryAddress.startsWith(wantPrefix);
}

/**
 * Resolve the active CIP-113 params for `network`: a (validated) settings override wins, else the
 * built-in table. Returns undefined when nothing is configured — callers skip all CIP-113 work then,
 * which is the default state today.
 */
export function cip113ParamsFor(
  network: Cip113Network,
  override?: Partial<Record<Cip113Network, Cip113Params>>,
): Cip113Params | undefined {
  const candidate = override?.[network] ?? BUILTIN_CIP113_PARAMS[network];
  return candidate !== undefined && isValidCip113Params(candidate, network) ? candidate : undefined;
}
