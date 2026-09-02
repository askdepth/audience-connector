// Shared test helpers. Not a `*.test.ts` file, so vitest does not collect it.

import { sign } from '@askdepth/audience-contract';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signedBodyFor } from '../src/verify-request';

export const TEST_SECRET = 'test-secret-p2';
export const TEST_PREVIOUS_SECRET = 'test-previous-secret-p2';
export const OTHER_SECRET = 'an-unrelated-third-secret';

export interface SignOpts {
  method?: string;
  /** Raw body bytes as sent (defaults to '' — appropriate for GET). */
  body?: string;
  /** Secret to sign with (defaults to TEST_SECRET). */
  secret?: string;
  /** Timestamp in **seconds** (defaults to now). */
  timestamp?: number;
  /** Sign over this body instead of `body` (to forge a mismatch). */
  signOverBody?: string;
  extraHeaders?: Record<string, string>;
}

/** Build the signature + timestamp (+ content-type) headers for a request. */
export function signedHeaders(opts: SignOpts = {}): Headers {
  const method = opts.method ?? 'POST';
  const body = opts.body ?? '';
  const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const secret = Buffer.from(opts.secret ?? TEST_SECRET, 'utf8');
  const signed = signedBodyFor(method, opts.signOverBody ?? body);
  const headers = new Headers({
    [SIGNATURE_HEADER]: sign(signed, ts, secret),
    [TIMESTAMP_HEADER]: String(ts),
  });
  if (method !== 'GET' && method !== 'HEAD') headers.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) headers.set(k, v);
  return headers;
}

/** Build a whole `Request` with a valid signature over its body. */
export function signedRequest(url: string, opts: SignOpts = {}): Request {
  const method = opts.method ?? 'POST';
  const body = opts.body ?? '';
  return new Request(url, {
    method,
    headers: signedHeaders(opts),
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}
