// N6 — a connector FAILS conformance if it "exceeds the 1,000-row result cap"
// (docs/conformance-spec.md, negative item 6).
//
// Normal polarity: a correct connector PASSES. The cap (master §6.3,
// `plan.ts` ROW_CAP = 1000, `endpoints.ts` SearchRequestSchema `.max(1000)`)
// is enforced two ways and both are checked over the wire:
//
//   1. An explicit `limit` over the cap is refused with the documented
//      `limit_exceeded` code (HTTP 400) — the adapter is never reached. The
//      exact code string is `limit_exceeded` (errors.ts CODE_TABLE,
//      HTTP 400, message "Request exceeds an allowed limit.").
//
//   2. No single response body ever carries more than 1,000 rows, whatever a
//      misbehaving connector attempts: a `limit: 1000` request must return
//      <= 1000 rows, and paging hard at `limit: 1000` must never yield a page
//      over 1,000 (the pages may sum past 1,000 — that is expected; a single
//      over-cap *response* is the violation).
//
// Check 2 is run over the unfiltered "everyone" query AND over a structurally
// filtered query (an `isActive` clause — either polarity — that the connector
// maps): a connector that appends `LIMIT 1000` on a full scan but omits it
// once a `WHERE` is present would pass an unfiltered-only check. If the
// connector maps no usable structural filter, the filtered leg is skipped with
// a note rather than failing.
//
// `detail` names the failing check and the observed count or code.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient } from '../../client';

const MAPPING = { src_external_id: 'externalId', src_email: 'email' };
const CAP = 1000;
const OVER_CAP = 1001;
const MAX_PAGES = 200;

type Criteria = Record<string, unknown>;
const ALL: Criteria = { all: [] };

// Structurally-filtered queries that need no prior knowledge of the data.
// Tried in order; the first that returns HTTP 200 with >= 1 row is used.
const FILTER_CANDIDATES: ReadonlyArray<{ label: string; criteria: Criteria }> = [
  { label: 'isActive == true', criteria: { all: [{ field: 'isActive', op: 'eq', value: true }] } },
  { label: 'isActive == false', criteria: { all: [{ field: 'isActive', op: 'eq', value: false }] } },
];

function fail(detail: string) {
  return { id: 'N6', pass: false, detail } as const;
}

async function search(
  client: ConformanceClient,
  limit: number,
  cursor: string | undefined,
  criteria: Criteria,
): Promise<
  | { ok: true; status: number; rows: unknown[]; nextCursor?: string; code?: string }
  | { ok: false; detail: string }
> {
  const body: Record<string, unknown> = { criteria, mapping: MAPPING, limit };
  if (cursor !== undefined) body.cursor = cursor;
  const res = await client.post('/candidates/search', body);

  let parsed: unknown;
  try {
    parsed = res.json();
  } catch {
    // A non-JSON body is only a problem for the paths that need to read it.
    return { ok: true, status: res.status, rows: [], nextCursor: undefined };
  }
  const rows = (parsed as { rows?: unknown }).rows;
  const nextCursor = (parsed as { nextCursor?: unknown }).nextCursor;
  const code = (parsed as { error?: { code?: unknown } }).error?.code;
  return {
    ok: true,
    status: res.status,
    rows: Array.isArray(rows) ? rows : [],
    nextCursor: typeof nextCursor === 'string' && nextCursor.length > 0 ? nextCursor : undefined,
    code: typeof code === 'string' ? code : undefined,
  };
}

/** Check 2 for one query: the at-cap response and every page must be <= CAP. */
async function capHoldsFor(
  client: ConformanceClient,
  criteria: Criteria,
  label: string,
): Promise<{ ok: true; maxPage: number; total: number } | { ok: false; detail: string }> {
  const atCap = await search(client, CAP, undefined, criteria);
  if (!atCap.ok) return { ok: false, detail: atCap.detail };
  if (atCap.status !== 200) {
    return { ok: false, detail: `${label}, limit ${CAP}: expected HTTP 200, observed HTTP ${atCap.status}` };
  }
  if (atCap.rows.length > CAP) {
    return {
      ok: false,
      detail: `${label}, limit ${CAP}: a single response returned ${atCap.rows.length} rows — the ${CAP}-row cap was exceeded`,
    };
  }

  let cursor = atCap.nextCursor;
  let total = atCap.rows.length;
  let maxPage = atCap.rows.length;
  for (let pages = 1; cursor && pages <= MAX_PAGES; pages++) {
    const next = await search(client, CAP, cursor, criteria);
    if (!next.ok) return { ok: false, detail: next.detail };
    if (next.status !== 200) {
      return { ok: false, detail: `${label}, limit ${CAP} page ${pages + 1}: expected HTTP 200, observed HTTP ${next.status}` };
    }
    if (next.rows.length > CAP) {
      return {
        ok: false,
        detail: `${label}, limit ${CAP} page ${pages + 1}: response returned ${next.rows.length} rows — the ${CAP}-row cap was exceeded`,
      };
    }
    total += next.rows.length;
    maxPage = Math.max(maxPage, next.rows.length);
    cursor = next.nextCursor;
  }
  return { ok: true, maxPage, total };
}

export const rowCapExceededCase: ConformanceCase = {
  id: 'N6',
  kind: 'negative',
  async run(client) {
    // 1. limit over the cap → documented rejection, adapter untouched.
    const over = await search(client, OVER_CAP, undefined, ALL);
    if (!over.ok) return fail(over.detail);
    if (over.status !== 400) {
      return fail(
        `limit ${OVER_CAP}: expected HTTP 400 with code "limit_exceeded", observed HTTP ${over.status}` +
          (over.rows.length ? ` and a body of ${over.rows.length} row(s)` : ''),
      );
    }
    if (over.code !== 'limit_exceeded') {
      return fail(
        `limit ${OVER_CAP}: expected error.code "limit_exceeded", observed ${JSON.stringify(over.code)}`,
      );
    }

    // 2a. The cap holds on the unfiltered "everyone" query.
    const unfiltered = await capHoldsFor(client, ALL, 'unfiltered');
    if (!unfiltered.ok) return fail(unfiltered.detail);

    // 2b. The cap also holds under a structural `WHERE` clause.
    let filteredNote = 'no mappable structural filter — filtered cap leg skipped';
    for (const cand of FILTER_CANDIDATES) {
      const probe = await search(client, CAP, undefined, cand.criteria);
      if (!probe.ok) return fail(probe.detail);
      if (probe.status !== 200 || probe.rows.length === 0) continue; // filter not usable
      const held = await capHoldsFor(client, cand.criteria, `filtered (${cand.label})`);
      if (!held.ok) return fail(held.detail);
      filteredNote = `filtered (${cand.label}): largest single response ${held.maxPage} row(s), ${held.total} across pages`;
      break;
    }

    return {
      id: 'N6',
      pass: true,
      detail:
        `limit ${OVER_CAP} rejected as limit_exceeded; unfiltered: largest single response ` +
        `${unfiltered.maxPage} row(s), ${unfiltered.total} across pages; ${filteredNote} — the ${CAP}-row cap held`,
    };
  },
};
