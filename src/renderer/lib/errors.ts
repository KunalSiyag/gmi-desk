import { ERROR_HINTS, GmiError, type GmiErrorCode } from '@shared/contracts/errors';

export interface ErrorView {
  code: GmiErrorCode;
  title: string;
  message: string;
}

/** Turns anything thrown into display text: a short title plus the detail GMI gave. */
export function describeError(error: unknown): ErrorView {
  if (error instanceof GmiError) {
    const hint = ERROR_HINTS[error.code];
    const message = error.message && error.message !== hint ? error.message : '';
    return { code: error.code, title: hint, message };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return { code: 'internal', title: ERROR_HINTS.internal, message };
}

export function errorCode(error: unknown): GmiErrorCode | null {
  return error instanceof GmiError ? error.code : null;
}
