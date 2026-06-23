// CIP-30 error codes (IMPLEMENTATION_PLAN §9). dApps distinguish errors by these exact numeric codes
// in context, so we implement them precisely. Over the bridge an error travels as `{ code, info }`.

export const APIErrorCode = {
  InvalidRequest: -1,
  InternalError: -2,
  Refused: -3,
  AccountChange: -4,
} as const;

export const TxSignErrorCode = {
  ProofGeneration: 1,
  UserDeclined: 2,
} as const;

export const DataSignErrorCode = {
  ProofGeneration: 1,
  AddressNotPK: 2,
  UserDeclined: 3,
} as const;

export const TxSendErrorCode = {
  Refused: 1,
  Failure: 2,
} as const;

/** A CIP-30 error carrying the spec's `{ code, info }` shape. */
export class Cip30Error extends Error {
  constructor(
    readonly code: number,
    readonly info: string,
  ) {
    super(info);
    this.name = 'Cip30Error';
  }
  /** Wire shape sent back across the bridge. */
  toJSON(): { code: number; info: string } {
    return { code: this.code, info: this.info };
  }
}

/** CIP-30 PaginateError has its own `{ maxSize }` shape (not `{ code, info }`). */
export class PaginateError extends Error {
  constructor(readonly maxSize: number) {
    super(`requested page out of range (maxSize=${maxSize})`);
    this.name = 'PaginateError';
  }
  toJSON(): { maxSize: number } {
    return { maxSize: this.maxSize };
  }
}

export const apiError = (code: number, info: string) => new Cip30Error(code, info);
export const refused = (info = 'user declined') => new Cip30Error(APIErrorCode.Refused, info);
export const internalError = (info: string) => new Cip30Error(APIErrorCode.InternalError, info);
export const invalidRequest = (info: string) => new Cip30Error(APIErrorCode.InvalidRequest, info);
export const txSendFailure = (info: string) => new Cip30Error(TxSendErrorCode.Failure, info);
