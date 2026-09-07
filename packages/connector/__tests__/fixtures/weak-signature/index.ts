// Deliberately-broken fixture — breaks N2 ONLY ("answers a request with an
// expired or malformed signature").
//
// Verification IS present, but weakened two ways the master doc calls out:
//   * a NON-timing-safe string compare (`===`) instead of `timingSafeEqual`;
//   * an EXPANDED time window (24h) instead of the contract's ±300s.
// A request that clears this weak check is re-signed with a fresh timestamp
// and handed to a genuine `createConnector`. An unsigned request (no headers)
// is still refused with the documented 401, so N1 stays green — only the
// "expired signature" half of N2 gets through.

import { sign } from '@askdepth/audience-contract';
import { signedBodyFor } from '../../../src/verify-request';
import { memAdapter } from '../../_mem-adapter';
import {
  SEED_SECRET,
  connectorFetch,
  seamClient,
  seedRows,
  SEED_COLUMNS,
} from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

const SIGNATURE_HEADER = 'x-askdepth-signature';
const TIMESTAMP_HEADER = 'x-askdepth-timestamp';
const WEAK_WINDOW_SECONDS = 24 * 60 * 60; // 86_400 — far beyond the ±300s spec.

function documented401(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'unauthorized', message: 'Request is not authorized.' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  );
}

export function createWeakSignatureClient(): ConformanceClient {
  const secret = Buffer.from(SEED_SECRET, 'utf8');
  const inner = connectorFetch(memAdapter(seedRows(), { columns: SEED_COLUMNS }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const raw = hasBody ? await src.clone().text() : '';

    const sig = src.headers.get(SIGNATURE_HEADER);
    const tsHeader = src.headers.get(TIMESTAMP_HEADER);
    if (!sig || !tsHeader) return documented401();

    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) return documented401();

    // WEAKNESS 1: a 24h window — a ~1000s-old timestamp sails through.
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > WEAK_WINDOW_SECONDS) {
      return documented401();
    }
    // WEAKNESS 2: plain `===`, not a constant-time compare.
    const expected = sign(signedBodyFor(method, raw), ts, secret);
    if (sig !== expected) return documented401();

    // Accepted by the weak check — re-sign fresh so the real gate agrees.
    const freshTs = Math.floor(Date.now() / 1000);
    const headers = new Headers(src.headers);
    headers.set(TIMESTAMP_HEADER, String(freshTs));
    headers.set(SIGNATURE_HEADER, sign(signedBodyFor(method, raw), freshTs, secret));
    return inner(String(input), { method, headers, body: hasBody ? raw : undefined });
  };

  return seamClient(fetchImpl);
}
