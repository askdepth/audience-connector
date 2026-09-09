import { z } from 'zod';

/**
 * The closed set of error codes a connector can emit. Every connector error
 * response is exactly `{ "error": { "code", "message" } }` with `code` drawn
 * from this list.
 *
 * Added to the contract in 0.1.2. The connector's own copy of this set lives in
 * `packages/connector/src/errors.ts` as the keys of `CODE_TABLE`; a test in
 * that package asserts the two agree. It is duplicated here — rather than the
 * connector importing this — deliberately: `errors.ts` is designed so the wire
 * message for a code is a fixed constant that cannot be interpolated, and that
 * file is not restructured for this release.
 *
 * Order matches `CODE_TABLE`'s key order.
 */
export const CONNECTOR_ERROR_CODES = [
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
] as const;
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

/**
 * The connector error envelope. The body is exactly these keys — the connector
 * guarantees no others, ever. The platform maps `code` onto its own error
 * taxonomy (`limit_exceeded` → its cap error, `expired_timestamp` /
 * `invalid_signature` → its auth error, `timeout` → its timeout, and so on).
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(CONNECTOR_ERROR_CODES),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
