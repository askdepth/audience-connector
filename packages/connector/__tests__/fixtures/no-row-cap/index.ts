// Deliberately-broken fixture — breaks N6 ONLY ("exceeds the 1,000-row result
// cap").
//
// The frozen handler defensively slices every adapter result to
// `plan.limit ?? ROW_CAP`, so an over-cap response body cannot come out of
// `createConnector` — this violation is only reachable from a hand-built seam
// (as noted in S4's `bigRowCapClient`). The seam verifies the signature like a
// real connector and delegates everything to a genuine `createConnector`,
// EXCEPT one narrowly-shaped request — an identity-only, unfiltered,
// `limit: 1000`, cursorless, non-sample search — for which it returns 1,500
// rows in a single body. That shape is exactly N6's at-cap probe and is not
// used by any positive case (P4/P7's unfiltered `limit: 1000` searches map a
// display `name`, so they are delegated untouched).

import { verify } from '@askdepth/audience-contract';
import { signedBodyFor } from '../../../src/verify-request';
import { memAdapter } from '../../_mem-adapter';
import { SEED_SECRET, connectorFetch, seamClient, seedRows, SEED_COLUMNS } from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

const OVER_CAP = 1500;

function isN6AtCapProbe(raw: string): boolean {
  let body: {
    limit?: unknown;
    cursor?: unknown;
    sample?: unknown;
    criteria?: { all?: unknown };
    mapping?: Record<string, unknown>;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return false;
  }
  if (body.limit !== 1000 || body.cursor !== undefined || body.sample !== undefined) return false;
  const all = body.criteria?.all;
  if (!Array.isArray(all) || all.length !== 0) return false;
  // Identity-only projection — no display `name` mapped (P4/P7 map one).
  const mapped = Object.values(body.mapping ?? {});
  return !mapped.includes('name');
}

export function createNoRowCapClient(): ConformanceClient {
  const secret = Buffer.from(SEED_SECRET, 'utf8');
  const inner = connectorFetch(memAdapter(seedRows(), { columns: SEED_COLUMNS }));
  const overCapRows = Array.from({ length: OVER_CAP }, (_, i) => ({
    externalId: `cap-${String(i).padStart(4, '0')}`,
    email: `cap${i}@synthetic.example`,
  }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const url = new URL(src.url);

    if (method === 'POST' && url.pathname.endsWith('/candidates/search')) {
      const raw = await src.clone().text();
      const ts = src.headers.get('x-askdepth-timestamp') ?? '';
      const sig = src.headers.get('x-askdepth-signature') ?? '';
      const authentic = verify(signedBodyFor(method, raw), ts, sig, secret).valid;
      if (authentic && isN6AtCapProbe(raw)) {
        // THE VIOLATION: one response body far over the 1,000-row cap.
        return new Response(JSON.stringify({ rows: overCapRows, nextCursor: undefined }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    return inner(input, init);
  };

  return seamClient(fetchImpl);
}
