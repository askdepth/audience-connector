// Helpers shared by the S3 authentication negative cases (N1, N2).
//
// Kept minimal on purpose. N4's credential regexes are DELIBERATELY not here —
// that case re-declares its own so it detects a leak independently of any
// shared code (see `error-leaks-data.ts`).

import type { WireResponse } from '../../client';

/**
 * The connector's documented auth-rejection codes. Sourced by reading the
 * frozen connector, not imported from it:
 *
 *   * `packages/connector/src/errors.ts` — `CODE_TABLE` renders every auth
 *     failure as HTTP 401 with the fixed body `{ "error": { code, message } }`
 *     (`toResponse`); `unauthorized`, `invalid_signature` and
 *     `expired_timestamp` are the three 401 codes.
 *   * `packages/connector/src/verify-request.ts` — emits `unauthorized` for a
 *     missing signature/timestamp header, `expired_timestamp` for a timestamp
 *     outside the ±300s window, and `invalid_signature` for anything else
 *     (wrong bytes, wrong length, non-numeric timestamp).
 *
 * Re-declared here as literals: a conformance case must not import connector
 * internals.
 */
export const AUTH_REJECTION_CODES = [
  'unauthorized',
  'invalid_signature',
  'expired_timestamp',
] as const;

export function excerpt(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Passes when `res` is the connector's **documented 401 rejection**:
 *
 *   * HTTP status exactly 401;
 *   * a JSON **object** body;
 *   * an `error` object carrying a string `code` that is one of
 *     {@link AUTH_REJECTION_CODES} and a non-empty string `message`.
 *
 * Extra keys beside `error` / beside `code`+`message` are tolerated (a real
 * connector may add a request id) — the graded contract is the status, the
 * envelope, and the code vocabulary. Anything else means the connector did not
 * cleanly reject the caller, and is returned as a `reason` string.
 */
export function isDocumented401(
  res: WireResponse,
): { ok: true } | { ok: false; reason: string } {
  if (res.status !== 401) {
    return { ok: false, reason: `expected HTTP 401, observed ${res.status}` };
  }

  let body: unknown;
  try {
    body = res.json();
  } catch {
    return { ok: false, reason: `expected a JSON body, observed non-JSON "${excerpt(res.bodyText)}"` };
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: `expected a JSON object body, observed "${excerpt(res.bodyText)}"` };
  }

  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null || Array.isArray(err)) {
    return { ok: false, reason: `expected an "error" object in the body, observed "${excerpt(res.bodyText)}"` };
  }

  const { code, message } = err as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !(AUTH_REJECTION_CODES as readonly string[]).includes(code)) {
    return {
      ok: false,
      reason: `expected error.code in {${AUTH_REJECTION_CODES.join(', ')}}, observed ${JSON.stringify(code)}`,
    };
  }
  if (typeof message !== 'string' || message.length === 0) {
    return { ok: false, reason: `expected a non-empty string error.message, observed ${JSON.stringify(message)}` };
  }

  return { ok: true };
}
