import { describe, it, expect } from 'vitest';
import { newId, TARGET_CONTENT, TARGET_INPAGE } from '../src/shared/messages';

describe('message protocol', () => {
  it('newId() returns unique UUIDs', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId()));
    expect(ids.size).toBe(1000);
  });

  it('targets are distinct (no inpage/content confusion)', () => {
    expect(TARGET_CONTENT).not.toBe(TARGET_INPAGE);
  });
});
