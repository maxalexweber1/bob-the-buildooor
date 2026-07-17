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
  /**
   * T9.4 transfer support (EXPERIMENTAL — gate lifted by human decision 2026-07-17, testnet only).
   * Optional: the read-only tier (discovery/display) works without it; transfers additionally need
   * the deployed validators. Scripts are supplied INLINE as compiled CBOR hex (the pragmatic devnet
   * path — upstream doesn't document where reference scripts live) and are HASH-VERIFIED against
   * their expected credentials before any build (a wrong script is a hard error, never a signature).
   */
  transfer?: Cip113TransferParams;
}

export interface Cip113TransferParams {
  /** Stake-script hash (56 hex) of the programmable-logic GLOBAL withdraw-zero validator. */
  programmableLogicGlobal: string;
  /** `txHash#index` of the protocol-parameters UTxO (mandatory reference input). */
  protocolParamsRef: string;
  /** Compiled Plutus V3 scripts, CBOR hex — passed AS-IS (never unwrap the CBOR layer; CLAUDE.md). */
  scripts: {
    /** programmable_logic_base spend validator — hash must equal `programmableLogicBase`. */
    base: string;
    /** programmable_logic_global stake validator — hash must equal `programmableLogicGlobal`. */
    global: string;
    /** Per-policy transfer-logic stake validators — hash must equal the REGISTRY node's credential. */
    transferLogic: Record<string, string>;
  };
}

/**
 * Built-in per-network deployment constants. Intentionally empty: no audited CIP-113 deployment
 * exists yet (upstream is R&D). When one ships, add its constants here — testnets first.
 */
export const BUILTIN_CIP113_PARAMS: Partial<Record<Cip113Network, Cip113Params>> = {};

const HASH28_RE = /^[0-9a-f]{56}$/;
const UTXO_REF_RE = /^[0-9a-f]{64}#\d+$/;
const CBOR_HEX_RE = /^[0-9a-f]{2,}$/i;

function isValidTransferParams(t: unknown): t is Cip113TransferParams {
  if (typeof t !== 'object' || t === null) return false;
  const o = t as Record<string, unknown>;
  if (typeof o.programmableLogicGlobal !== 'string' || !HASH28_RE.test(o.programmableLogicGlobal)) return false;
  if (typeof o.protocolParamsRef !== 'string' || !UTXO_REF_RE.test(o.protocolParamsRef)) return false;
  const s = o.scripts as Record<string, unknown> | undefined;
  if (typeof s !== 'object' || s === null) return false;
  if (typeof s.base !== 'string' || !CBOR_HEX_RE.test(s.base)) return false;
  if (typeof s.global !== 'string' || !CBOR_HEX_RE.test(s.global)) return false;
  if (typeof s.transferLogic !== 'object' || s.transferLogic === null) return false;
  return Object.entries(s.transferLogic as Record<string, unknown>).every(
    ([policy, hex]) => HASH28_RE.test(policy) && typeof hex === 'string' && CBOR_HEX_RE.test(hex),
  );
}

/** Structural + format validation for one params entry. Trust-no-input: these come from storage. */
export function isValidCip113Params(p: unknown, network: Cip113Network): p is Cip113Params {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  if (typeof o.programmableLogicBase !== 'string' || !HASH28_RE.test(o.programmableLogicBase)) return false;
  if (typeof o.registryNodePolicyId !== 'string' || !HASH28_RE.test(o.registryNodePolicyId)) return false;
  if (typeof o.registryAddress !== 'string') return false;
  // Transfer support is optional, but if configured it must be well-formed — a half-broken transfer
  // config should be a visible rejection, not a runtime surprise inside the builder.
  if (o.transfer !== undefined && !isValidTransferParams(o.transfer)) return false;
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
