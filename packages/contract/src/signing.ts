import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The ±window, in seconds, within which a request timestamp is accepted.
 * `verify()` checks this *before* computing any HMAC. Exported so the platform
 * knows how much clock skew it has to work with, and can tell a retryable
 * `expired_timestamp` (re-sign with a fresh timestamp — worth retrying) from a
 * hard failure.
 */
export const REPLAY_WINDOW_SECONDS = 300;

/**
 * Signs `${timestamp}.${rawBody}` with the connector's own secret:
 * HMAC-SHA256, constant-time verification, length check before compare.
 *
 * Returns the full header value: `'v1=' + <hex digest>`. Callers put this
 * string in `SIGNATURE_HEADER` verbatim — nothing prepends `v1=` a second time.
 */
export function sign(rawBody: string, timestamp: number, secret: Buffer): string {
  const payload = `${timestamp}.${rawBody}`;
  return 'v1=' + createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * The two wire header names an HMAC-signed request carries. The value of
 * `SIGNATURE_HEADER` is the return of {@link sign} verbatim — it already
 * includes the `v1=` prefix.
 */
export const SIGNATURE_HEADER = 'x-askdepth-signature';
export const TIMESTAMP_HEADER = 'x-askdepth-timestamp';

/**
 * The body that is signed for a given HTTP method. Methods that carry no
 * request body — GET and HEAD — sign the empty string, so the signed payload
 * is `${timestamp}.`; every other method signs `${timestamp}.${rawBody}` over
 * the exact bytes received.
 *
 * This lives beside {@link sign}/{@link verify} because it is part of the same
 * question — *what gets signed* — and both the connector (verifying) and the
 * platform (signing) must construct the payload identically. A GET that signs
 * anything other than the empty body fails every request with `401`, silently,
 * with nothing pointing at body construction.
 */
export function signedBodyFor(method: string, rawBody: string): string {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' ? '' : rawBody;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'malformed' | 'expired' | 'mismatch';
}

export function verify(
  rawBody: string,
  timestampHeader: string,
  signatureHeader: string,
  secret: Buffer,
  now: number = Date.now() / 1000,
): VerifyResult {
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return { valid: false, reason: 'malformed' };
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) return { valid: false, reason: 'expired' };

  const expected = sign(rawBody, timestamp, secret);
  const provided = Buffer.from(signatureHeader, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  // Length check before timingSafeEqual — it throws on length mismatch
  // rather than returning false. This is not itself a timing side-channel:
  // it reveals only "well-formed or not", never anything about the secret.
  if (provided.length !== expectedBuf.length) return { valid: false, reason: 'mismatch' };
  return { valid: timingSafeEqual(provided, expectedBuf), reason: 'mismatch' };
}
