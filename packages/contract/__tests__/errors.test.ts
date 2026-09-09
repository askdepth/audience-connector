import { describe, it, expect } from 'vitest';
import { CONNECTOR_ERROR_CODES, ErrorResponseSchema } from '../src/errors';

describe('CONNECTOR_ERROR_CODES', () => {
  it('is the closed set of twelve connector error codes, in CODE_TABLE order', () => {
    expect(CONNECTOR_ERROR_CODES).toEqual([
      'unauthorized',
      'invalid_signature',
      'expired_timestamp',
      'malformed_request',
      'unsupported_capability',
      'limit_exceeded',
      'invalid_cursor',
      'not_found',
      'method_not_allowed',
      'adapter_error',
      'timeout',
      'internal',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(CONNECTOR_ERROR_CODES).size).toBe(CONNECTOR_ERROR_CODES.length);
  });
});

describe('ErrorResponseSchema', () => {
  it('accepts the exact { error: { code, message } } shape', () => {
    expect(
      ErrorResponseSchema.safeParse({
        error: { code: 'limit_exceeded', message: 'Request exceeds an allowed limit.' },
      }).success,
    ).toBe(true);
  });

  it('accepts every code in the union', () => {
    for (const code of CONNECTOR_ERROR_CODES) {
      expect(ErrorResponseSchema.safeParse({ error: { code, message: 'x' } }).success).toBe(true);
    }
  });

  it('rejects an unknown code', () => {
    expect(ErrorResponseSchema.safeParse({ error: { code: 'kaboom', message: 'x' } }).success).toBe(
      false,
    );
  });

  it('rejects a missing message', () => {
    expect(ErrorResponseSchema.safeParse({ error: { code: 'internal' } }).success).toBe(false);
  });

  it('rejects a bare string body', () => {
    expect(ErrorResponseSchema.safeParse('nope').success).toBe(false);
  });
});
