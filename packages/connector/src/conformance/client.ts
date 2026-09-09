// The conformance client is **pure over-the-wire**: it is nothing but `fetch`
// plus the contract package's `sign()`. It never imports `handler.ts`,
// `verify-request.ts` or any adapter — a conformance run must exercise a
// connector exactly as the platform would, with no shared code to mask a
// defect.
//
// HMAC lives in `@askdepth/audience-contract`'s `sign()` and is never
// reimplemented here. The wire header names and `signedBodyFor()` — the rule
// for *what* gets signed — come from the same package: it is the single source
// of truth for the signing scheme, and this file still imports nothing from
// connector internals.

import {
  sign,
  signedBodyFor,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '@askdepth/audience-contract';

/** A structurally valid `v1=<64 hex>` signature that will never verify. */
function corruptSignature(signature: string): string {
  const last = signature.slice(-1);
  const flipped = last === '0' ? '1' : '0';
  return signature.slice(0, -1) + flipped;
}

/**
 * How far in the past `postWithExpiredSignature` back-dates its timestamp.
 * The contract's replay window is ±300s; 1000s is unambiguously outside it in
 * either direction after clock skew, so `verify()` short-circuits to
 * `reason: 'expired'` before it computes any HMAC. N2 also probes just outside
 * the boundary (~330s) via {@link ConformanceClient.postWithSkewedSignature} —
 * a connector with a lax replay window rejects the 1000s probe yet accepts a
 * 330s-stale replay.
 */
const EXPIRED_SIGNATURE_SKEW_SECONDS = 1000;

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return b + p;
}

/**
 * Strip any `user:password@` credentials from a URL before it goes anywhere a
 * human (a log line, an error message, the `--json` report) will read it.
 * Parses with `new URL`, blanks `username`/`password`, and returns the
 * round-tripped string. On a parse failure the input is returned unchanged —
 * redaction is best-effort, never a reason to throw.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Blank `user:password@` credentials out of every `scheme://…@host` URL that
 * appears **inside** a larger string — an error message, a log line. `fetch`
 * itself rejects a credentialed URL with a `TypeError` that echoes the raw URL
 * back, so a message forwarded from a failed request can carry a secret even
 * when the URL was never logged directly.
 */
export function redactUrlsInText(text: string): string {
  // scheme:// … up to the last '@' before the next '/', '?', '#' or whitespace.
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi, '$1');
}

/** Default ceiling on how many bytes of a response body the client will read. */
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Read `res.body` into a string, stopping after `maxBytes`. A hostile connector
 * that streams gigabytes must not be able to OOM the CLI, so the read is
 * bounded rather than `await res.text()`. Returns the (possibly truncated)
 * decoded prefix and whether truncation occurred. A null body (HEAD, 204)
 * yields the empty string.
 */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body) return { text: '', truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Abandon the rest of the stream; the connection is not reused.
    try {
      await reader.cancel();
    } catch {
      /* stream already closed — nothing to do */
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), truncated };
}

/** A read response, with the body already drained to a string. */
export interface WireResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
  /**
   * True when the response body exceeded `maxBodyBytes` and `bodyText` holds
   * only the truncated prefix. `false` for every body read in full.
   */
  truncated: boolean;
  /** Parse `bodyText` as JSON. Throws if the body is not JSON. */
  json<T = unknown>(): T;
}

/** Raised when the connector could not be reached at all (DNS, refused, timeout). */
export class ConnectionError extends Error {
  readonly url: string;
  override readonly cause: unknown;
  constructor(url: string, cause: unknown) {
    super(`could not reach ${redactUrl(url)}`);
    this.name = 'ConnectionError';
    // Raw URL kept on the instance for programmatic use; only the message is redacted.
    this.url = url;
    this.cause = cause;
  }
}

export interface ConformanceClient {
  readonly url: string;
  /** Signed GET. */
  get(path: string): Promise<WireResponse>;
  /** Signed POST with a JSON body. */
  post(path: string, body: unknown): Promise<WireResponse>;
  /** GET with **no** signature or timestamp header at all. */
  getUnsigned(path: string): Promise<WireResponse>;
  /**
   * POST with a JSON body and `content-type: application/json` but **no**
   * `x-askdepth-signature` / `x-askdepth-timestamp` header at all — the write
   * analogue of {@link getUnsigned}. N1 uses it to prove a connector rejects an
   * unsigned request to the *data* endpoints, not only to GET routes.
   */
  postUnsigned(path: string, body: unknown): Promise<WireResponse>;
  /** POST whose signature header is well-formed (`v1=<64 hex>`) but does not verify. */
  postWithBadSignature(path: string, body: unknown): Promise<WireResponse>;
  /**
   * POST whose signature is computed **correctly** over the body, but over a
   * timestamp far outside the ±300s replay window — i.e. well-formed yet
   * expired. Used by N2 alongside {@link postWithBadSignature}. Equivalent to
   * `postWithSkewedSignature(path, body, EXPIRED_SIGNATURE_SKEW_SECONDS)`.
   */
  postWithExpiredSignature(path: string, body: unknown): Promise<WireResponse>;
  /**
   * POST whose signature is computed **correctly** over the body, but over a
   * timestamp `now - skewSeconds`. Positive `skewSeconds` back-dates the
   * timestamp (a stale replay); negative `skewSeconds` post-dates it (a
   * future-dated request). N2 uses it to probe just outside the ±300s replay
   * window (~330s past and ~330s future) as well as far outside it.
   */
  postWithSkewedSignature(
    path: string,
    body: unknown,
    skewSeconds: number,
  ): Promise<WireResponse>;
  /**
   * A correctly-signed request with an arbitrary HTTP method. Used by N8 to
   * fire `PUT`/`DELETE`/`PATCH` (and `POST`) at the connector; a body is sent —
   * and signed — only when `body !== undefined` and the method carries one.
   */
  request(method: string, path: string, body?: unknown): Promise<WireResponse>;
}

export interface ConformanceClientOptions {
  /** Base URL of the connector, e.g. `https://host/askdepth/v1`. */
  url: string;
  /** Active signing secret. */
  secret: string;
  /**
   * Previous signing secret, accepted during a rotation overlap. Held for
   * rotation-related negative cases in later stages; unused in S1.
   */
  previousSecret?: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /**
   * Ceiling on how many bytes of a response body to read. On overflow the read
   * stops, `WireResponse.bodyText` holds the truncated prefix, and
   * `WireResponse.truncated` is `true`. Default 10 MiB.
   */
  maxBodyBytes?: number;
  /** Test seam: replaces global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: current time in ms. Default `Date.now`. */
  now?: () => number;
}

export function createConformanceClient(options: ConformanceClientOptions): ConformanceClient {
  const { url, secret } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const secretBuf = Buffer.from(secret, 'utf8');

  function signatureHeaders(method: string, rawBody: string): Record<string, string> {
    const timestamp = Math.floor(now() / 1000);
    const signature = sign(signedBodyFor(method, rawBody), timestamp, secretBuf);
    return { [TIMESTAMP_HEADER]: String(timestamp), [SIGNATURE_HEADER]: signature };
  }

  /** POST a correctly-signed body over a timestamp offset by `skewSeconds`
   *  (positive = past, negative = future). Backs both
   *  `postWithSkewedSignature` and `postWithExpiredSignature`. */
  function sendSkewedPost(path: string, body: unknown, skewSeconds: number): Promise<WireResponse> {
    const raw = JSON.stringify(body ?? {});
    const timestamp = Math.floor(now() / 1000) - skewSeconds;
    const signature = sign(signedBodyFor('POST', raw), timestamp, secretBuf);
    const headers = new Headers({
      'content-type': 'application/json',
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signature,
    });
    return send('POST', path, headers, raw);
  }

  async function send(
    method: string,
    path: string,
    headers: Headers,
    body: string | undefined,
  ): Promise<WireResponse> {
    const target = joinUrl(url, path);
    let res: Response;
    try {
      res = await fetchImpl(target, {
        method,
        headers,
        body,
        // Never follow a 3xx: it would replay the signed request / auth headers
        // to another host, and N8 needs to observe a redirect as an "answered"
        // write path rather than transparently chasing it.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ConnectionError(target, err);
    }
    const { text: bodyText, truncated } = await readBoundedBody(res, maxBodyBytes);
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      bodyText,
      truncated,
      json<T = unknown>(): T {
        try {
          return JSON.parse(bodyText) as T;
        } catch {
          throw new Error(`response body from ${redactUrl(target)} is not JSON`);
        }
      },
    };
  }

  return {
    url,

    get(path) {
      return send('GET', path, new Headers(signatureHeaders('GET', '')), undefined);
    },

    post(path, body) {
      const raw = JSON.stringify(body ?? {});
      const headers = new Headers({
        'content-type': 'application/json',
        ...signatureHeaders('POST', raw),
      });
      return send('POST', path, headers, raw);
    },

    getUnsigned(path) {
      // Deliberately empty: no signature, no timestamp. The connector — not
      // this client — is responsible for rejecting it.
      return send('GET', path, new Headers(), undefined);
    },

    postUnsigned(path, body) {
      // A real JSON POST body, but — like `getUnsigned` — no signature and no
      // timestamp header. Rejecting it is the connector's job.
      const raw = JSON.stringify(body ?? {});
      return send('POST', path, new Headers({ 'content-type': 'application/json' }), raw);
    },

    postWithBadSignature(path, body) {
      const raw = JSON.stringify(body ?? {});
      const timestamp = Math.floor(now() / 1000);
      const good = sign(signedBodyFor('POST', raw), timestamp, secretBuf);
      const headers = new Headers({
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: corruptSignature(good),
      });
      return send('POST', path, headers, raw);
    },

    postWithSkewedSignature(path, body, skewSeconds) {
      return sendSkewedPost(path, body, skewSeconds);
    },

    postWithExpiredSignature(path, body) {
      return sendSkewedPost(path, body, EXPIRED_SIGNATURE_SKEW_SECONDS);
    },

    request(method, path, body) {
      const m = method.toUpperCase();
      const carriesBody = body !== undefined && m !== 'GET' && m !== 'HEAD';
      const raw = carriesBody ? JSON.stringify(body) : '';
      const headers = new Headers(signatureHeaders(m, raw));
      if (carriesBody) headers.set('content-type', 'application/json');
      return send(m, path, headers, carriesBody ? raw : undefined);
    },
  };
}
