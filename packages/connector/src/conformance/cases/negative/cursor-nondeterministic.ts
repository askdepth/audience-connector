// N5 — a connector FAILS conformance if it "returns non-deterministic cursor
// pagination" (docs/conformance-spec.md, negative item 5).
//
// Normal polarity: a correct connector PASSES. Deterministic pagination has
// three observable properties, all proven here over the wire (the postgres and
// in-memory adapters prove the same internally — plan.test.ts S5.12/S5.14,
// postgres.test.ts S6.10/S6.11):
//
//   1. Paging all the way through returns every id once — no id repeats across
//      pages.
//   2. No id is dropped: the union of the pages equals the full result set
//      (learned from a separate, larger-page pass over the same query).
//   3. Requesting the *same cursor* twice returns byte-identical rows.
//
// A connector that orders by `random()` (or reseeds per request) violates 1
// and/or 3. `ORDER BY random()` satisfies "random subsample" but destroys
// this; the contract's answer is a per-pull seed carried in the cursor.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient } from '../../client';

const MAPPING = { src_external_id: 'externalId', src_email: 'email' };

// Below the 1,000-row cap on purpose: this pass must not itself brush against
// N6 territory.
const DISCOVERY_LIMIT = 500;
const MAX_PAGES = 500;

function fail(detail: string) {
  return { id: 'N5', pass: false, detail } as const;
}

interface Page {
  ids: string[];
  nextCursor?: string;
  bodyText: string;
}

async function searchPage(
  client: ConformanceClient,
  limit: number,
  cursor?: string,
): Promise<{ ok: true; page: Page } | { ok: false; detail: string }> {
  const body: Record<string, unknown> = { criteria: { all: [] }, mapping: MAPPING, limit };
  if (cursor !== undefined) body.cursor = cursor;
  const res = await client.post('/candidates/search', body);
  if (res.status !== 200) {
    return { ok: false, detail: `POST /candidates/search → HTTP ${res.status}: "${res.bodyText.slice(0, 160)}"` };
  }
  let parsed: unknown;
  try {
    parsed = res.json();
  } catch {
    return { ok: false, detail: `search response is not JSON: "${res.bodyText.slice(0, 160)}"` };
  }
  const rows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    return { ok: false, detail: `search response has no rows[]: "${JSON.stringify(parsed).slice(0, 160)}"` };
  }
  const ids: string[] = [];
  for (const [idx, row] of rows.entries()) {
    const id = (row as { externalId?: unknown }).externalId;
    if (typeof id !== 'string') {
      return { ok: false, detail: `row ${idx} has a non-string externalId: ${JSON.stringify(row).slice(0, 120)}` };
    }
    ids.push(id);
  }
  const nextCursor = (parsed as { nextCursor?: unknown }).nextCursor;
  return {
    ok: true,
    page: {
      ids,
      nextCursor: typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : undefined,
      bodyText: res.bodyText,
    },
  };
}

/** Drain every page at `limit`; flags a repeat as it goes. */
async function drain(
  client: ConformanceClient,
  limit: number,
): Promise<
  | { ok: true; order: string[]; firstNextCursor?: string; pages: number }
  | { ok: false; detail: string }
> {
  const order: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let firstNextCursor: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const r = await searchPage(client, limit, cursor);
    if (!r.ok) return r;
    for (const id of r.page.ids) {
      if (seen.has(id)) {
        return {
          ok: false,
          detail: `paging at limit ${limit}: id "${id}" was returned twice (page ${pages}) — cursor pagination is not deterministic`,
        };
      }
      seen.add(id);
      order.push(id);
    }
    if (pages === 1) firstNextCursor = r.page.nextCursor;
    if (!r.page.nextCursor) return { ok: true, order, firstNextCursor, pages };
    cursor = r.page.nextCursor;
  }
  return { ok: false, detail: `pagination did not terminate within ${MAX_PAGES} pages at limit ${limit}` };
}

export const cursorNondeterministicCase: ConformanceCase = {
  id: 'N5',
  kind: 'negative',
  async run(client) {
    // Pass 1 — larger pages — establishes the full id set for this query.
    const big = await drain(client, DISCOVERY_LIMIT);
    if (!big.ok) return fail(big.detail);
    const fullSet = new Set(big.order);
    const total = fullSet.size;

    if (total < 2) {
      return {
        id: 'N5',
        pass: true,
        detail: `precondition: need >= 2 candidates to exercise pagination, observed ${total} — nothing unstable seen`,
      };
    }

    // Pass 2 — small pages — must reproduce exactly the same set, no repeats.
    const pageLimit = Math.min(250, Math.max(1, Math.ceil(total / 12)));
    const small = await drain(client, pageLimit);
    if (!small.ok) return fail(small.detail);

    const smallSet = new Set(small.order);
    for (const id of fullSet) {
      if (!smallSet.has(id)) {
        return fail(
          `id "${id}" was returned when paging at limit ${DISCOVERY_LIMIT} but skipped when paging at limit ${pageLimit} — pages do not cover the result set`,
        );
      }
    }
    for (const id of smallSet) {
      if (!fullSet.has(id)) {
        return fail(
          `id "${id}" appeared only when paging at limit ${pageLimit} — the page window is not stable across runs`,
        );
      }
    }

    if (small.pages < 2 || !small.firstNextCursor) {
      return {
        id: 'N5',
        pass: true,
        detail: `paged ${total} id(s) with no repeats or gaps; result set too small (${total}) at limit ${pageLimit} to re-request a cursor`,
      };
    }

    // Pass 3 — the same cursor, twice — must be byte-identical.
    const a = await searchPage(client, pageLimit, small.firstNextCursor);
    if (!a.ok) return fail(a.detail);
    const b = await searchPage(client, pageLimit, small.firstNextCursor);
    if (!b.ok) return fail(b.detail);
    if (a.page.bodyText !== b.page.bodyText) {
      const aIds = a.page.ids.join(',');
      const bIds = b.page.ids.join(',');
      return fail(
        `requesting the same cursor twice returned different responses — page A ids [${aIds.slice(0, 120)}], page B ids [${bIds.slice(0, 120)}]`,
      );
    }

    return {
      id: 'N5',
      pass: true,
      detail: `paged ${total} id(s) at limit ${DISCOVERY_LIMIT} and ${pageLimit} with no repeats or gaps; a re-requested cursor returned identical bytes`,
    };
  },
};
