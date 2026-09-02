import { createHmac, timingSafeEqual } from 'node:crypto';

const REPLAY_WINDOW_SECONDS = 300;

/**
 * Signs `${timestamp}.${rawBody}` with the connector's own secret:
 * HMAC-SHA256, constant-time verification, length check before compare.
 */
export function sign(rawBody: string, timestamp: number, secret: Buffer): string {
  const payload = `${timestamp}.${rawBody}`;
  return 'v1=' + createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
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
