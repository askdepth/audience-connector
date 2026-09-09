// The signature gate. An unsigned or badly-signed request cannot reach an
// adapter, structurally: `handler.ts` calls `verifyRequest` before it parses
// the body, chooses a route, or constructs an adapter context. An adapter has
// no code path that could skip this — there is deliberately no configuration
// field, environment variable, or build flag that disables it (master §2).
//
// HMAC itself lives in `@askdepth/audience-contract`'s `verify()` and is not
// reimplemented here.

import {
  verify,
  signedBodyFor,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@askdepth/audience-contract';
import { ConnectorError } from './errors';

// Re-exported from the contract so this module's existing import surface is
// unchanged — internal callers and `__tests__/verify-request.test.ts` still do
// `import { SIGNATURE_HEADER, TIMESTAMP_HEADER } from './verify-request'`. The
// contract is the single definition; see `@askdepth/audience-contract`'s
// `signing.ts`.
export { signedBodyFor, SIGNATURE_HEADER, TIMESTAMP_HEADER };

export interface VerifyRequestConfig {
  /** Active signing secret. */
  secret: string | Buffer;
  /** Previous secret, accepted during a rotation overlap (master §6.4). */
  previousSecret?: string | Buffer;
  /** Test seam: current time in **seconds**. Defaults to wall clock. */
  clock?: () => number;
}

function toBuffer(secret: string | Buffer): Buffer {
  return typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
}

/**
 * Verifies the signature and timestamp of an incoming request. Returns
 * normally when the request is authentic; throws a {@link ConnectorError}
 * otherwise:
 *
 * - a missing or empty signature/timestamp header → `unauthorized`
 * - a timestamp outside the 300s replay window (either direction) →
 *   `expired_timestamp`
 * - anything else (bad signature, non-numeric timestamp, wrong length) →
 *   `invalid_signature`
 *
 * During rotation both `secret` and `previousSecret` are tried. Which one
 * matched is never reported back — the connector's own status reflects it,
 * the wire does not.
 *
 * Replay: the 300s window is the only bound. The connector holds no nonce
 * store, so the same authentic request replayed inside the window verifies
 * again — the platform is the side responsible for not re-sending. This is a
 * deliberate v1 position; the test suite asserts it so a later change is
 * visible.
 */
export function verifyRequest(
  method: string,
  headers: Headers,
  rawBody: string,
  config: VerifyRequestConfig,
): void {
  const signature = headers.get(SIGNATURE_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);

  if (!signature || !timestamp) {
    throw new ConnectorError('unauthorized', {
      missing: !signature ? SIGNATURE_HEADER : TIMESTAMP_HEADER,
    });
  }

  const body = signedBodyFor(method, rawBody);
  const now = config.clock ? config.clock() : undefined;

  // `verify()` checks the timestamp window *before* it computes any HMAC, so a
  // stale request short-circuits to `reason: 'expired'` here regardless of
  // which secret it was signed with — `previousSecret` would see the same.
  const primary = verify(body, timestamp, signature, toBuffer(config.secret), now);
  if (primary.valid) return;

  // The second HMAC on failure is a small timing tell of "which rotation
  // secret matched" — accepted: both secrets are equally valid in the overlap
  // window, no key material leaks, `verify()` itself is constant-time, and the
  // *wire* result is identical (this function returns void either way).
  if (config.previousSecret !== undefined) {
    const rotated = verify(body, timestamp, signature, toBuffer(config.previousSecret), now);
    if (rotated.valid) return;
  }

  // Surface the primary attempt's reason. `expired` and `malformed` are
  // secret-independent, so this is identical to what `previousSecret` saw.
  if (primary.reason === 'expired') {
    throw new ConnectorError('expired_timestamp');
  }
  throw new ConnectorError('invalid_signature');
}
