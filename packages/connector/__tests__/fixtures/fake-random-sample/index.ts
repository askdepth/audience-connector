// Deliberately-broken fixture — breaks N7 ONLY ("returns a non-random
// subsample when `randomSample` is advertised").
//
// A genuine `createConnector` that advertises `randomSample` (the in-memory
// adapter's default capability set), but whose adapter answers a `sample`
// request with the first `size` rows in INSERTION order — i.e. the oldest
// `size` by `signupAt`, since the seeded base's `signupAt` increases
// monotonically. Non-sample reads (every other case) are delegated untouched.

import type { Adapter, CanonicalRow } from '../../../src/types';
import type { QueryPlan } from '../../../src/plan';
import { memAdapter } from '../../_mem-adapter';
import { connectorFetch, seamClient, seedRows, SEED_COLUMNS } from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

export function createFakeRandomSampleClient(): ConformanceClient {
  const source = seedRows();
  const base = memAdapter(source, { columns: SEED_COLUMNS });

  const adapter: Adapter = {
    ...base,
    async search(plan: QueryPlan, ctx) {
      if (!plan.sample) return base.search(plan, ctx);
      // THE VIOLATION: "random" sample == the oldest N by signup order.
      const size = plan.sample.size;
      const rows = source.slice(0, size).map(
        (r) =>
          ({
            externalId: r.externalId,
            email: r.email,
            signupAt: r.signupAt,
          }) as CanonicalRow,
      );
      return { rows, nextCursor: undefined };
    },
  };

  return seamClient(connectorFetch(adapter));
}
