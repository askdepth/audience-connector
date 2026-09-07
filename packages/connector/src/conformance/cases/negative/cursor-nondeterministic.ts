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
// Those three are checked TWICE: once over the unfiltered "everyone" query, and
// once over an explicit `externalId IN (…)` subset (learned from the first
// pass, paged small to force multiple pages). A connector can be deterministic
// on a full scan yet lose `ORDER BY` / cursor stability once a `WHERE` clause
// narrows the set — the filtered pass catches that.
//
// A connector that orders by `random()` (or reseeds per request) violates 1
// and/or 3. `ORDER BY random()` satisfies "random subsample" but destroys
// this; the contract's answer is a per-pull seed carried in the cursor.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient } from '../../client';

const MAPPING = { src_external_id: 'externalId', src_email: 'email' };

type Criteria = Record<string, unknown>;
const ALL: Criteria = { all: [] };

// Below the 1,000-row cap on purpose: this pass must not itself brush against
// N6 territory.
const DISCOVERY_LIMIT = 500;
const MAX_PAGES = 500;
// How many ids the filtered pass pins into an `externalId IN (…)` clause.
const FILTERED_SUBSET = 200;

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
  cursor: string | undefined,
  criteria: Criteria,
): Promise<{ ok: true; page: Page } | { ok: false; detail: string }> {
  const body: Record<string, unknown> = { criteria, mapping: MAPPING, limit };
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

/** Drain every page at `limit` for `criteria`; flags a repeat as it goes. */
async function drain(
  client: ConformanceClient,
  limit: number,
  criteria: Criteria,
): Promise<
  | { ok: true; order: string[]; firstNextCursor?: string; pages: number }
  | { ok: false; detail: string }
> {
  const order: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let firstNextCursor: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const r = await searchPage(client, limit, cursor, criteria);
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

/** Passes 1–3 for a single query. `label` names the query in any failure. */
async function checkQuery(
  client: ConformanceClient,
  criteria: Criteria,
  label: string,
  expectedIds?: ReadonlySet<string>,
): Promise<{ ok: true; total: number; order: string[] } | { ok: false; detail: string }> {
  // Pass 1 — larger pages — establishes the full id set for this query.
  const big = await drain(client, DISCOVERY_LIMIT, criteria);
  if (!big.ok) return { ok: false, detail: `${label}: ${big.detail}` };
  const fullSet = new Set(big.order);
  const total = fullSet.size;

  if (expectedIds) {
    for (const id of expectedIds) {
      if (!fullSet.has(id)) {
        return {
          ok: false,
          detail: `${label}: id "${id}" was requested via the criteria but never returned when paging at limit ${DISCOVERY_LIMIT} — filtered pagination drops rows`,
        };
      }
    }
    for (const id of fullSet) {
      if (!expectedIds.has(id)) {
        return {
          ok: false,
          detail: `${label}: id "${id}" was returned but is not in the requested set — filtered pagination is unstable`,
        };
      }
    }
  }

  if (total < 2) {
    return { ok: true, total, order: big.order };
  }

  // Pass 2 — small pages — must reproduce exactly the same set, no repeats.
  const pageLimit = Math.min(250, Math.max(1, Math.ceil(total / 12)));
  const small = await drain(client, pageLimit, criteria);
  if (!small.ok) return { ok: false, detail: `${label}: ${small.detail}` };

  const smallSet = new Set(small.order);
  for (const id of fullSet) {
    if (!smallSet.has(id)) {
      return {
        ok: false,
        detail: `${label}: id "${id}" was returned when paging at limit ${DISCOVERY_LIMIT} but skipped when paging at limit ${pageLimit} — pages do not cover the result set`,
      };
    }
  }
  for (const id of smallSet) {
    if (!fullSet.has(id)) {
      return {
        ok: false,
        detail: `${label}: id "${id}" appeared only when paging at limit ${pageLimit} — the page window is not stable across runs`,
      };
    }
  }

  if (small.pages < 2 || !small.firstNextCursor) {
    return { ok: true, total, order: big.order };
  }

  // Pass 3 — the same cursor, twice — must be byte-identical.
  const a = await searchPage(client, pageLimit, small.firstNextCursor, criteria);
  if (!a.ok) return { ok: false, detail: `${label}: ${a.detail}` };
  const b = await searchPage(client, pageLimit, small.firstNextCursor, criteria);
  if (!b.ok) return { ok: false, detail: `${label}: ${b.detail}` };
  if (a.page.bodyText !== b.page.bodyText) {
    const aIds = a.page.ids.join(',');
    const bIds = b.page.ids.join(',');
    return {
      ok: false,
      detail: `${label}: requesting the same cursor twice returned different responses — page A ids [${aIds.slice(0, 120)}], page B ids [${bIds.slice(0, 120)}]`,
    };
  }

  return { ok: true, total, order: big.order };
}

export const cursorNondeterministicCase: ConformanceCase = {
  id: 'N5',
  kind: 'negative',
  async run(client) {
    // Unfiltered pass — the "everyone" query.
    const unfiltered = await checkQuery(client, ALL, 'unfiltered scan');
    if (!unfiltered.ok) return fail(unfiltered.detail);
    const total = unfiltered.total;

    if (total < 2) {
      return {
        id: 'N5',
        pass: true,
        detail: `precondition: need >= 2 candidates to exercise pagination, observed ${total} — nothing unstable seen`,
      };
    }

    // Filtered pass — the same three checks under a `WHERE externalId IN (…)`.
    // The subset is drawn from the unfiltered pass (reusing its drained order),
    // so every requested id genuinely exists. `checkQuery`'s pass 2 pages this
    // ~200-id subset at `ceil(200/12)` ≈ 17 rows/page, forcing multiple pages.
    const subset = unfiltered.order.slice(0, Math.min(FILTERED_SUBSET, unfiltered.order.length));
    if (subset.length < 3) {
      return {
        id: 'N5',
        pass: true,
        detail: `paged ${total} id(s) unfiltered with no repeats or gaps and a stable re-requested cursor; only ${subset.length} id(s) available — too few to exercise a filtered pass`,
      };
    }

    const subsetSet = new Set(subset);
    const filterCriteria: Criteria = {
      all: [{ field: 'externalId', op: 'in', values: subset }],
    };
    const filtered = await checkQuery(
      client,
      filterCriteria,
      `filtered scan (externalId IN, ${subset.length} ids)`,
      subsetSet,
    );
    if (!filtered.ok) return fail(filtered.detail);

    return {
      id: 'N5',
      pass: true,
      detail:
        `paged ${total} id(s) unfiltered and ${filtered.total} id(s) under an externalId IN filter, ` +
        `both with no repeats or gaps; a re-requested cursor returned identical bytes on both passes`,
    };
  },
};
