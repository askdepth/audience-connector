// The conformance client is **pure over-the-wire**: it is nothing but `fetch`
// plus the contract package's `sign()`. It never imports `handler.ts`,
// `verify-request.ts` or any adapter — a conformance run must exercise a
// connector exactly as the platform would, with no shared code to mask a
// defect.
//
// HMAC lives in `@askdepth/audience-contract`'s `sign()` and is never
// reimplemented here.

import { sign } from '@askdepth/audience-contract';

// Wire header names. Mirrored deliberately as literals rather than imported
// from `verify-request.ts` (which exports the same constants) so this file has
// zero dependency on connector internals. If the contract's signing scheme
// changes these must change with it — `verify-request.ts` is the source of
// truth on the connector side.
const SIGNATURE_HEADER = 'x-askdepth-signature';
const TIMESTAMP_HEADER = 'x-askdepth-timestamp';

/**
 * The bytes that get signed for a given method. GET/HEAD carry no body and
 * sign the empty string (so the signed payload is `${timestamp}.`); every
 * other method signs the exact request body. This mirrors `signedBodyFor()` in
 * `verify-request.ts`.
 */
function signedBodyFor(method: string, rawBody: string): string {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD' ? '' : rawBody;
}

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
 * `reason: 'expired'` before it computes any HMAC.
 */
const EXPIRED_SIGNATURE_SKEW_SECONDS = 1000;

function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return b + p;
}

/** A read response, with the body already drained to a string. */
export interface WireResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
  /** Parse `bodyText` as JSON. Throws if the body is not JSON. */
  json<T = unknown>(): T;
}

/** Raised when the connector could not be reached at all (DNS, refused, timeout). */
export class ConnectionError extends Error {
  readonly url: string;
  override readonly cause: unknown;
  constructor(url: string, cause: unknown) {
    super(`could not reach ${url}`);
    this.name = 'ConnectionError';
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
  /** POST whose signature header is well-formed (`v1=<64 hex>`) but does not verify. */
  postWithBadSignature(path: string, body: unknown): Promise<WireResponse>;
  /**
   * POST whose signature is computed **correctly** over the body, but over a
   * timestamp far outside the ±300s replay window — i.e. well-formed yet
   * expired. Used by N2 alongside {@link postWithBadSignature}.
   */
  postWithExpiredSignature(path: string, body: unknown): Promise<WireResponse>;
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
  /** Test seam: replaces global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam: current time in ms. Default `Date.now`. */
  now?: () => number;
}

export function createConformanceClient(options: ConformanceClientOptions): ConformanceClient {
  const { url, secret } = options;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const secretBuf = Buffer.from(secret, 'utf8');

  function signatureHeaders(method: string, rawBody: string): Record<string, string> {
    const timestamp = Math.floor(now() / 1000);
    const signature = sign(signedBodyFor(method, rawBody), timestamp, secretBuf);
    return { [TIMESTAMP_HEADER]: String(timestamp), [SIGNATURE_HEADER]: signature };
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
      res = await fetchImpl(target, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new ConnectionError(target, err);
    }
    const bodyText = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      bodyText,
      json<T = unknown>(): T {
        try {
          return JSON.parse(bodyText) as T;
        } catch {
          throw new Error(`response body from ${target} is not JSON`);
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

    postWithExpiredSignature(path, body) {
      const raw = JSON.stringify(body ?? {});
      // Back-dated well past the replay window; the signature itself is valid
      // for this (stale) timestamp.
      const timestamp = Math.floor(now() / 1000) - EXPIRED_SIGNATURE_SKEW_SECONDS;
      const signature = sign(signedBodyFor('POST', raw), timestamp, secretBuf);
      const headers = new Headers({
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: String(timestamp),
        [SIGNATURE_HEADER]: signature,
      });
      return send('POST', path, headers, raw);
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
