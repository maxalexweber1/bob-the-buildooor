import { describe, it, expect } from 'vitest';
import { decodeTxMessage } from '../src/core/tx/txMessage';

// Fixtures in buildooor's TxMetadata.toJson() shape: a metadatum map is [{k,v}], text is {text}, a
// list is a plain array. Mirrors the real round-tripped output for label 674.
const text = (s: string) => ({ text: s });
const msgMap = (lines: string[], extra: Array<{ k: unknown; v: unknown }> = []) => ({
  '674': [{ k: text('msg'), v: lines.map(text) }, ...extra],
});

describe('decodeTxMessage — CIP-20/CIP-83 (standards review)', () => {
  it('decodes a single-line message', () => {
    expect(decodeTxMessage(msgMap(['gm cardano']))).toEqual({ lines: ['gm cardano'], encrypted: false });
  });

  it('decodes a multi-line message in order', () => {
    expect(decodeTxMessage(msgMap(['line 1', 'line 2', 'line 3']))).toEqual({
      lines: ['line 1', 'line 2', 'line 3'],
      encrypted: false,
    });
  });

  it('leniently accepts a single text node (not wrapped in a list) as the msg value', () => {
    expect(decodeTxMessage({ '674': [{ k: text('msg'), v: text('just one') }] })).toEqual({
      lines: ['just one'],
      encrypted: false,
    });
  });

  it('flags CIP-83 encryption when an "enc" key is present (no fake plaintext)', () => {
    const enc = { '674': [{ k: text('msg'), v: [text('U2FsdGVk…ciphertext')] }, { k: text('enc'), v: text('basic') }] };
    expect(decodeTxMessage(enc)).toEqual({ lines: ['U2FsdGVk…ciphertext'], encrypted: true });
  });

  it('returns a message even if "enc" is present with no readable lines', () => {
    expect(decodeTxMessage({ '674': [{ k: text('enc'), v: text('basic') }] })).toEqual({
      lines: [],
      encrypted: true,
    });
  });

  it('returns undefined when there is no 674 label', () => {
    expect(decodeTxMessage({ '721': [{ k: text('name'), v: text('NFT') }] })).toBeUndefined();
    expect(decodeTxMessage({})).toBeUndefined();
  });

  it('returns undefined when 674 has neither msg nor enc', () => {
    expect(decodeTxMessage({ '674': [{ k: text('other'), v: text('x') }] })).toBeUndefined();
  });

  it('ignores non-text entries within the msg list', () => {
    const mixed = { '674': [{ k: text('msg'), v: [text('keep'), { int: '5' }, 42, null, text('me')] }] };
    expect(decodeTxMessage(mixed)).toEqual({ lines: ['keep', 'me'], encrypted: false });
  });

  it('is total on malformed / hostile input (never throws)', () => {
    expect(decodeTxMessage(undefined)).toBeUndefined();
    expect(decodeTxMessage(null)).toBeUndefined();
    expect(decodeTxMessage('674')).toBeUndefined();
    expect(decodeTxMessage({ '674': 'not-a-map' })).toBeUndefined();
    expect(decodeTxMessage({ '674': [{ no: 'kv' }, 7] })).toBeUndefined();
  });
});
