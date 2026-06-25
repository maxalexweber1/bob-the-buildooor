// Regression guard against the "SecondFi" class of Ed25519 bug (Coinspect finding, 2025).
//
// Ed25519 (CIP-1852 / RFC 8032) derives its per-signature nonce as
//     r = H( secret_prefix || message )
// where `secret_prefix` is the upper 32 bytes of the extended private key. A broken implementation
// that drops the secret half — computing r = H(message) — makes the nonce a pure function of the
// (public, on-chain) transaction, which leaks the private key from a SINGLE signature.
//
// We never implement Ed25519 ourselves; both signing paths bottom out in @harmoniclabs/crypto's
// `signExtendedEd25519_sync` (tx via Tx.signWith, CIP-8 via core/cose/sign). These tests pin that
// primitive so a dependency downgrade/regression to a message-only nonce is caught in CI rather
// than on-chain. See CLAUDE.md §1.9 (pure-JS crypto, no hand-rolled primitives).
import { describe, it, expect } from 'vitest';
import { signExtendedEd25519_sync } from '@harmoniclabs/buildooor';
import { mnemonicToRoot, deriveKey, Role } from '../src/core/keys';
import { toHex, utf8ToBytes } from '../src/core/crypto/encoding';

const root = mnemonicToRoot('abandon '.repeat(23) + 'art');
const key0 = deriveKey(root, 0, Role.External, 0);
const key1 = deriveKey(root, 0, Role.External, 1);
const MSG = utf8ToBytes('bob-the-buildooor ed25519 KAT v1');

const sigOf = (k: typeof key0, m: Uint8Array) =>
  signExtendedEd25519_sync(m, k.toPrivateKeyBytes()).signature;

describe('Ed25519 nonce integrity (SecondFi regression)', () => {
  it('known-answer vector: pinned signature for a fixed key + message', () => {
    // If the library ever changes how the nonce is derived, this exact value changes and the test
    // fails — turning a silent crypto regression into a loud CI failure.
    const sig = sigOf(key0, MSG);
    expect(sig.length).toBe(64);
    expect(toHex(sig)).toBe(
      '1e43fe1db70b6c9590e977aba779b0a6da97d2539eceeadc89b497148594f292' +
        '767078404723202b83283fb4aa4ef3c5715d8b9ad534eac89fede039322bae04',
    );
  });

  it('nonce depends on the SECRET key, not just the message (the SecondFi invariant)', () => {
    // Same message, two different secret keys. R is the first 32 bytes of the signature.
    // Correct Ed25519: r = H(secret_prefix || message) → R differs because the secret differs.
    // Broken (SecondFi): r = H(message) → R would be IDENTICAL for both keys. That must never hold.
    const r0 = toHex(sigOf(key0, MSG).slice(0, 32));
    const r1 = toHex(sigOf(key1, MSG).slice(0, 32));
    expect(r0).not.toBe(r1);
  });

  it('is deterministic: identical key + message reproduce the identical signature', () => {
    // Determinism is the *intended* property (no RNG). It must come from H(secret || message),
    // which the two checks above pin down to the secret-dependent form.
    expect(toHex(sigOf(key0, MSG))).toBe(toHex(sigOf(key0, MSG)));
  });
});
