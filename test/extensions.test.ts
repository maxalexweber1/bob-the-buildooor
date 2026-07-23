import { describe, it, expect } from 'vitest';
import {
  EXTENSION_REGISTRY,
  SUPPORTED_EXTENSION_CIPS,
  SUPPORTED_EXTENSIONS,
  negotiateExtensions,
  extensionCipOf,
  extensionWireKey,
} from '../src/shared/extensions';

describe('CIP-30 extension registry (T4.7)', () => {
  it('advertises CIP-95 as supported', () => {
    expect(SUPPORTED_EXTENSION_CIPS).toContain(95);
    expect(SUPPORTED_EXTENSIONS).toContainEqual({ cip: 95 });
  });

  it('CIP-95: getRegisteredPubStakeKeys is un-namespaced (root); the rest are namespaced', () => {
    // Verified verbatim against cardano-foundation/CIPs CIP-0095/README.md method headings:
    //   api.cip95.getPubDRepKey / api.getRegisteredPubStakeKeys / api.cip95.getUnregisteredPubStakeKeys / api.cip95.signData
    const cip95 = EXTENSION_REGISTRY.find((e) => e.cip === 95);
    if (!cip95) throw new Error('CIP-95 missing from registry');
    const placement = Object.fromEntries(cip95.methods.map((m) => [m.name, m.placement]));
    expect(placement.getRegisteredPubStakeKeys).toBe('root');
    expect(placement.getPubDRepKey).toBe('namespaced');
    expect(placement.getUnregisteredPubStakeKeys).toBe('namespaced');
    expect(placement.signData).toBe('namespaced');
  });

  it('CIP-95: every registered method is implemented', () => {
    // The registry must only ever advertise methods the background can actually serve — a dApp that
    // negotiates CIP-95 must never hit a not-implemented method at runtime.
    const cip95 = EXTENSION_REGISTRY.find((e) => e.cip === 95);
    if (!cip95) throw new Error('CIP-95 missing from registry');
    expect(cip95.methods.map((m) => m.name).sort()).toEqual([
      'getPubDRepKey',
      'getRegisteredPubStakeKeys',
      'getUnregisteredPubStakeKeys',
      'signData',
    ]);
  });

  it('advertises CIP-103 as supported', () => {
    expect(SUPPORTED_EXTENSION_CIPS).toContain(103);
    expect(SUPPORTED_EXTENSIONS).toContainEqual({ cip: 103 });
  });

  it('CIP-103: exactly signTxs + submitTxs, both namespaced', () => {
    // Verified verbatim against cardano-foundation/CIPs CIP-0103/README.md:
    //   api.cip103.signTxs(txs) / api.cip103.submitTxs(txs)
    const cip103 = EXTENSION_REGISTRY.find((e) => e.cip === 103);
    if (!cip103) throw new Error('CIP-103 missing from registry');
    expect(cip103.methods.map((m) => m.name).sort()).toEqual(['signTxs', 'submitTxs']);
    expect(cip103.methods.every((m) => m.placement === 'namespaced')).toBe(true);
  });

  it('extensionWireKey is always cip{N}.{method} regardless of placement', () => {
    expect(extensionWireKey('cip95', 'getRegisteredPubStakeKeys')).toBe('cip95.getRegisteredPubStakeKeys');
  });

  it('extensionCipOf parses extension methods and ignores core methods', () => {
    expect(extensionCipOf('cip95.getPubDRepKey')).toBe(95);
    expect(extensionCipOf('cip103.signTxs')).toBe(103);
    expect(extensionCipOf('getBalance')).toBeNull();
    expect(extensionCipOf('signTx')).toBeNull();
  });
});

describe('negotiateExtensions (T4.6)', () => {
  it('grants supported requested extensions, drops unsupported', () => {
    expect(negotiateExtensions([{ cip: 95 }])).toEqual([95]);
    expect(negotiateExtensions([{ cip: 999 }])).toEqual([]);
    expect(negotiateExtensions([{ cip: 95 }, { cip: 999 }])).toEqual([95]);
  });

  it('grants several extensions at once, in requested order', () => {
    expect(negotiateExtensions([{ cip: 103 }, { cip: 95 }])).toEqual([103, 95]);
  });

  it('dedupes repeated requests', () => {
    expect(negotiateExtensions([{ cip: 95 }, { cip: 95 }])).toEqual([95]);
  });

  it('is total on malformed / hostile input (never throws)', () => {
    expect(negotiateExtensions(undefined)).toEqual([]);
    expect(negotiateExtensions('nope')).toEqual([]);
    expect(negotiateExtensions([null, 7, { nope: 1 }, { cip: '95' }])).toEqual([]);
  });
});
