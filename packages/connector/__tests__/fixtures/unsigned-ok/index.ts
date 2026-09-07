// Deliberately-broken fixture — breaks N1 ONLY ("answers an unsigned request").
//
// This is the ONE place in the repo where the `verify-request` gate is allowed
// to be bypassed, and it lives only under `__tests__/fixtures/`. The wrapper
// serves an unsigned request by minting a fresh valid signature for it before
// handing it to a genuine `createConnector`; a request that DOES carry
// signature headers is forwarded untouched, so the real gate still rejects a
// bad or expired signature (N2 stays green).

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

export function createUnsignedOkClient(): ConformanceClient {
  const secret = Buffer.from(SEED_SECRET, 'utf8');
  const inner = connectorFetch(memAdapter(seedRows(), { columns: SEED_COLUMNS }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const hasSig = src.headers.has(SIGNATURE_HEADER) && src.headers.has(TIMESTAMP_HEADER);
    if (hasSig) {
      // Signed (well or badly) — let the real gate decide.
      return inner(input, init);
    }

    // THE VIOLATION: an unsigned caller is served anyway. Mint a signature so
    // the frozen `verify-request` waves it through.
    const method = src.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const raw = hasBody ? await src.clone().text() : '';
    const ts = Math.floor(Date.now() / 1000);
    const headers = new Headers(src.headers);
    headers.set(TIMESTAMP_HEADER, String(ts));
    headers.set(SIGNATURE_HEADER, sign(signedBodyFor(method, raw), ts, secret));
    return inner(String(input), { method, headers, body: hasBody ? raw : undefined });
  };

  return seamClient(fetchImpl);
}
