import { describe, it, expect } from 'vitest';
import {
  Cip30Error,
  apiError,
  refused,
  txSendFailure,
  APIErrorCode,
  TxSignErrorCode,
  DataSignErrorCode,
  TxSendErrorCode,
} from '../src/shared/errors';

describe('CIP-30 error codes (spec §9)', () => {
  it('uses the exact spec codes', () => {
    expect(APIErrorCode).toMatchObject({ InvalidRequest: -1, InternalError: -2, Refused: -3, AccountChange: -4 });
    expect(TxSignErrorCode).toMatchObject({ ProofGeneration: 1, UserDeclined: 2 });
    expect(DataSignErrorCode).toMatchObject({ ProofGeneration: 1, AddressNotPK: 2, UserDeclined: 3 });
    expect(TxSendErrorCode).toMatchObject({ Refused: 1, Failure: 2 });
  });

  it('Cip30Error carries {code,info} and serializes to the wire shape', () => {
    const e = refused('nope');
    expect(e).toBeInstanceOf(Cip30Error);
    expect(e.code).toBe(-3);
    expect(e.info).toBe('nope');
    expect(JSON.stringify(e)).toBe('{"code":-3,"info":"nope"}');
  });

  it('helpers set the right codes', () => {
    expect(apiError(-1, 'x').code).toBe(-1);
    expect(txSendFailure('boom').code).toBe(2);
  });
});
