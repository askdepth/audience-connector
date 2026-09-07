// Deliberately-broken fixture — breaks N4 ONLY ("leaks credentials or row data
// in an error response").
//
// The frozen handler wraps every adapter throw into a fixed-text
// `adapter_error`, so a real connector CANNOT leak here — the violation is
// only reachable from a hand-built seam. This seam verifies the signature like
// a real connector by delegating, and delegates every request to a genuine
// `createConnector` EXCEPT the specific error-probing shapes N4 sends: those
// get a fabricated 5xx whose message carries a raw driver connection string
// and a row fragment, unredacted.

import { verify } from '@askdepth/audience-contract';
import { signedBodyFor } from '../../../src/verify-request';
import { memAdapter } from '../../_mem-adapter';
import { SEED_SECRET, connectorFetch, seamClient, seedRows, SEED_COLUMNS } from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

// The exact markers N4 plants in its probes (see `error-leaks-data.ts`).
const TRACER_TOKEN = 'zzTRACERzz';
const FAKE_DSN_IN = 'postgres://user:pw@host:5432/db';

// What the seam leaks back — a credential-shaped connection string and a row
// fragment, the two things §2 forbids in an error body.
const LEAK_DSN = 'postgres://svc_reader:hunter2@prod-db.internal:5432/candidates';
const LEAK_ROW = 'email=victim@real-user.example';

export function createLeakyErrorsClient(): ConformanceClient {
  const secret = Buffer.from(SEED_SECRET, 'utf8');
  const inner = connectorFetch(memAdapter(seedRows(), { columns: SEED_COLUMNS }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const url = new URL(src.url);
    const isDataPost =
      method === 'POST' &&
      (url.pathname.endsWith('/candidates/count') || url.pathname.endsWith('/candidates/search'));

    if (isDataPost) {
      const raw = await src.clone().text();
      const ts = src.headers.get('x-askdepth-timestamp') ?? '';
      const sig = src.headers.get('x-askdepth-signature') ?? '';
      const authentic = verify(signedBodyFor(method, raw), ts, sig, secret).valid;
      if (authentic && (raw.includes(TRACER_TOKEN) || raw.includes(FAKE_DSN_IN))) {
        // THE VIOLATION: the raw driver failure reaches the wire verbatim.
        return new Response(
          JSON.stringify({
            error: {
              code: 'adapter_error',
              message: `query failed: connection to ${LEAK_DSN} refused while filtering ${raw}; last row seen: { ${LEAK_ROW} }`,
            },
          }),
          { status: 502, headers: { 'content-type': 'application/json' } },
        );
      }
    }

    return inner(input, init);
  };

  return seamClient(fetchImpl);
}
