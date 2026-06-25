// Single source of truth for the CIP-30 extensions this wallet supports (T4.6/T4.7).
// Imported by BOTH the inpage provider (to advertise `supportedExtensions` and BUILD the granted
// extension namespaces) and the background (to negotiate `enable({extensions})`, gate extension
// calls, and answer `getExtensions()`). Framework-free, no chrome.*, safe in the MAIN-world bundle.
//
// CIP-30 §extensions: an extension is a plain `{ cip: N }` object (integer, no leading zeros); the
// wallet need not grant every requested extension and must not fail on unknown ones. We grant the
// intersection of (requested ∩ supported). Adding a new extension = add an entry to EXTENSION_REGISTRY
// (data) + a handler in the background switch (logic) — the bridge/dispatch is generic.

/** A CIP-30 extension descriptor as it appears on the wire and in `supportedExtensions`. */
export interface Extension {
  cip: number;
}

/**
 * Where an extension method sits on the api object:
 *  - 'namespaced' → `api.cipNN.method()` (the default per CIP-30)
 *  - 'root'       → `api.method()` (un-namespaced; a per-spec exception, e.g. CIP-95
 *                   `getRegisteredPubStakeKeys`, verified against CIP-0095/README.md headings)
 */
export type MethodPlacement = 'namespaced' | 'root';

export interface ExtensionMethodDef {
  /** JS method name the dApp calls. */
  name: string;
  placement: MethodPlacement;
}

export interface ExtensionDef {
  cip: number;
  /** Namespace object key on the api, e.g. 'cip95'. Also the prefix of the internal wire routing key. */
  namespace: string;
  methods: ExtensionMethodDef[];
}

/** Every extension this wallet can grant, with the exact api shape each exposes. */
export const EXTENSION_REGISTRY: ExtensionDef[] = [
  {
    cip: 95, // Conway governance (CIP-95)
    namespace: 'cip95',
    methods: [
      { name: 'getPubDRepKey', placement: 'namespaced' },
      // Per CIP-0095 spec the heading is `api.getRegisteredPubStakeKeys()` — un-namespaced.
      { name: 'getRegisteredPubStakeKeys', placement: 'root' },
      { name: 'getUnregisteredPubStakeKeys', placement: 'namespaced' },
      { name: 'signData', placement: 'namespaced' },
    ],
  },
];

/** CIP numbers of every extension this wallet can grant. */
export const SUPPORTED_EXTENSION_CIPS: readonly number[] = EXTENSION_REGISTRY.map((e) => e.cip);

/** `supportedExtensions` value for the injected provider object. */
export const SUPPORTED_EXTENSIONS: Extension[] = SUPPORTED_EXTENSION_CIPS.map((cip) => ({ cip }));

/**
 * Internal bridge routing token for an extension method — ALWAYS `cip{N}.{name}`, independent of the
 * JS placement. So `api.getRegisteredPubStakeKeys()` (root) still routes over the wire as
 * `cip95.getRegisteredPubStakeKeys`, keeping the background dispatch namespace-uniform.
 */
export function extensionWireKey(namespace: string, method: string): string {
  return `${namespace}.${method}`;
}

/** Parse a wire method into its CIP number, or null if it is not an extension method. */
export function extensionCipOf(method: string): number | null {
  const m = /^cip(\d+)\./.exec(method);
  return m ? Number(m[1]) : null;
}

/**
 * Negotiate the extensions to grant for an `enable({extensions})` call. Returns the CIP numbers we
 * actually support out of those requested. Input is whatever the (untrusted) dApp sent — validate
 * every element rather than trusting the shape (CLAUDE.md §6). Never throws on a malformed request.
 */
export function negotiateExtensions(requested: unknown): number[] {
  if (!Array.isArray(requested)) return [];
  const supported = new Set<number>(SUPPORTED_EXTENSION_CIPS);
  const granted: number[] = [];
  for (const e of requested) {
    const cip = (e as { cip?: unknown } | null)?.cip;
    if (typeof cip === 'number' && supported.has(cip) && !granted.includes(cip)) {
      granted.push(cip);
    }
  }
  return granted;
}
