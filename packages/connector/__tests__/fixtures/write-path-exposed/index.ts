// Deliberately-broken fixture — breaks N8 ONLY ("exposes any write path").
//
// A genuine `createConnector` with an extra route bolted on beside it, the way
// a careless framework mount would: `DELETE /candidates/:id` answers 200. Every
// other method and path — including the real read endpoints and the criteria
// DSL — is delegated untouched, so N8's "the DSL cannot be turned into a
// write" half and every other case still pass.

import { memAdapter } from '../../_mem-adapter';
import { connectorFetch, seamClient, seedRows, SEED_COLUMNS } from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

export function createWritePathExposedClient(): ConformanceClient {
  const inner = connectorFetch(memAdapter(seedRows(), { columns: SEED_COLUMNS }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const url = new URL(src.url);

    // THE VIOLATION: an extra write route mounted next to the connector.
    if (method === 'DELETE' && /\/candidates\/\d+$/.test(url.pathname)) {
      return new Response(JSON.stringify({ deleted: url.pathname.split('/').pop() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return inner(input, init);
  };

  return seamClient(fetchImpl);
}
