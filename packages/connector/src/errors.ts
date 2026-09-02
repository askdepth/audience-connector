// The connector's entire error model.
//
// Master §2 requires that an error response carry no row data and no
// credentials. The reliable way to guarantee that is to make it *impossible*
// to put a variable in a wire message, rather than to review every throw site:
//
//   1. There is exactly one error type (`ConnectorError`) and one closed set
//      of codes.
//   2. The wire message for each code is a fixed constant in `CODE_TABLE`.
//      `toResponse` reads the message from that table, never from the error
//      instance, so even a coerced third-party `Error` cannot leak its text.
//   3. Anything an implementer might want to log locally goes in `detail`,
//      which is never serialised. `redact()` scrubs it first.
//
// Conformance case 4 grades exactly this.

export type ConnectorErrorCode =
  | 'unauthorized'
  | 'invalid_signature'
  | 'expired_timestamp'
  | 'malformed_request'
  | 'unsupported_capability'
  | 'limit_exceeded'
  | 'invalid_cursor'
  | 'not_found'
  | 'method_not_allowed'
  | 'adapter_error'
  | 'timeout'
  | 'internal';

interface CodeSpec {
  readonly httpStatus: number;
  /** Fixed, input-free. Never interpolated. */
  readonly message: string;
}

const CODE_TABLE: Readonly<Record<ConnectorErrorCode, CodeSpec>> = {
  unauthorized: { httpStatus: 401, message: 'Request is not authorized.' },
  invalid_signature: { httpStatus: 401, message: 'Request signature verification failed.' },
  expired_timestamp: { httpStatus: 401, message: 'Request timestamp is outside the allowed window.' },
  malformed_request: { httpStatus: 400, message: 'Request is malformed.' },
  unsupported_capability: {
    httpStatus: 400,
    message: 'Request uses a capability this connector does not support.',
  },
  limit_exceeded: { httpStatus: 400, message: 'Request exceeds an allowed limit.' },
  invalid_cursor: { httpStatus: 400, message: 'Pagination cursor is invalid.' },
  // 404/405 are still rendered as the standard `{ error: { code, message } }`
  // body (S4). They sit outside the "auth / validation / adapter" grouping but
  // are part of the same closed set — nothing reaches the wire without a code.
  not_found: { httpStatus: 404, message: 'No such endpoint.' },
  method_not_allowed: { httpStatus: 405, message: 'Method not allowed on this endpoint.' },
  adapter_error: { httpStatus: 502, message: 'The data adapter failed to answer the request.' },
  timeout: { httpStatus: 504, message: 'The request exceeded its time budget.' },
  internal: { httpStatus: 500, message: 'Internal connector error.' },
};

/** Every code the connector can produce, with its HTTP status. Exposed for
 *  tests and documentation; the wire never sees anything outside this set. */
export const ERROR_CODES: ReadonlyArray<ConnectorErrorCode> = Object.freeze(
  Object.keys(CODE_TABLE) as ConnectorErrorCode[],
);

/** The fixed HTTP status for a code. */
export function httpStatusFor(code: ConnectorErrorCode): number {
  return CODE_TABLE[code].httpStatus;
}

/** The fixed, input-free wire message for a code. */
export function wireMessageFor(code: ConnectorErrorCode): string {
  return CODE_TABLE[code].message;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly httpStatus: number;
  /**
   * Internal-only diagnostic context. **Never serialised to the wire.** May
   * hold a driver message, a stack, a partial row — anything useful in a local
   * log. Pass it through {@link redact} before logging.
   */
  readonly detail?: unknown;

  constructor(code: ConnectorErrorCode, detail?: unknown) {
    // The fixed message is used for the JS stack too, so `super()` gets it —
    // but `toResponse` never reads `this.message`; it goes back to the table.
    super(CODE_TABLE[code].message);
    this.name = 'ConnectorError';
    this.code = code;
    this.httpStatus = CODE_TABLE[code].httpStatus;
    if (detail !== undefined) this.detail = detail;
    // Restore prototype chain under transpiled `extends Error`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The single path by which any error reaches the wire. A `ConnectorError` is
 * rendered from the code table; anything else is coerced to `internal` with
 * its own message discarded.
 *
 * The body is exactly `{ "error": { "code", "message" } }` — no other keys,
 * ever.
 */
export function toResponse(err: unknown): Response {
  const code: ConnectorErrorCode = err instanceof ConnectorError ? err.code : 'internal';
  const spec = CODE_TABLE[code];
  const body = JSON.stringify({ error: { code, message: spec.message } });
  return new Response(body, {
    status: spec.httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// redact() — for anything an implementer chooses to log locally.
// ---------------------------------------------------------------------------

const CONNECTION_STRING = /\b[a-z][a-z0-9+.-]*:\/\/[^\s@'"]+@\S+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const KEYED_SECRET =
  /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|token|authorization|auth)(\s*["']?\s*[:=]\s*["']?)([^\s,;"'}]+)/gi;

/**
 * Masks credential-shaped substrings in free text: connection strings
 * (`scheme://user:pass@host`), `Bearer <token>` values, and
 * `key: value` / `key=value` pairs where the key names a secret. Leaves
 * everything else untouched.
 *
 * Best-effort defence for local logs — not a substitute for keeping secrets
 * out of `detail` in the first place.
 */
export function redact(input: string): string {
  return input
    .replace(CONNECTION_STRING, '[redacted-connection-string]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(KEYED_SECRET, (_m, key: string, sep: string) => `${key}${sep}[redacted]`);
}
