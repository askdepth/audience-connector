// Deliberately-broken fixture — breaks N5 ONLY ("returns non-deterministic
// cursor pagination").
//
// A genuine `createConnector`, but its adapter re-orders the WHOLE result set
// by an unstable key on every call and ignores `plan.after` for row selection
// (it still borrows a real `nextCursor` from the in-memory reference so paging
// terminates). Two consecutive pages therefore draw from different orderings
// of the same rows: at a page size that is more than half the result set,
// pigeonhole guarantees a row is returned twice — which is exactly what N5
// flags. The re-order key is a pure hash, so the failure is deterministic; no
// RNG is involved.
//
// `count`, projection and the 1,000-row cap are untouched, so every other case
// passes.

import type { Adapter } from '../../../src/types';
import { shuffleHash, ROW_CAP, type QueryPlan } from '../../../src/plan';
import { pageInMemory, memAdapter } from '../../_mem-adapter';
import { connectorFetch, seamClient, seedRows, SEED_COLUMNS } from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

export function createNondeterministicCursorClient(): ConformanceClient {
  const source = seedRows();
  const base = memAdapter(source, { columns: SEED_COLUMNS });

  const adapter: Adapter = {
    ...base,
    async search(plan: QueryPlan, ctx) {
      // Borrow the reference page only for its has-more signal / cursor token.
      const real = await base.search(plan, ctx);

      // The correctly filtered + projected full set, in its stable order.
      const full = pageInMemory(source, { ...plan, after: undefined, limit: ROW_CAP });

      // THE VIOLATION: a fresh ordering per request (keyed on nothing but
      // "is this a first page or a continuation"), and `plan.after` ignored.
      const nonce = plan.after ? 'after' : 'first';
      const limit = plan.limit ?? ROW_CAP;
      const rows = [...full.rows]
        .map((r) => ({ r, k: shuffleHash(nonce, r.externalId) }))
        .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
        .slice(0, limit)
        .map(({ r }) => r);

      return { rows, nextCursor: real.nextCursor };
    },
  };

  return seamClient(connectorFetch(adapter));
}
