// P4 — `POST /candidates/search` respects `limit` and returns a `cursor` when
// more rows exist.
//
// conformance-spec.md, positive item 4. The wire field is `nextCursor`
// (handler response shape `{ rows, nextCursor }`); "cursor" in the spec text
// refers to that token.
//
// Size-agnostic: the case does not assume anything about how many rows the
// connector holds. It first pulls a small page to learn a few real
// `externalId`s, then pins the working set to exactly those ids with an
// `externalId IN` clause and paginates that bounded set at `limit: 2`. What is
// proven:
//   * no page is larger than `limit`;
//   * every non-final page holds exactly `limit` rows and carries a
//     `nextCursor` string;
//   * the final page carries no `nextCursor`;
//   * following the cursor advances — consecutive pages share no id;
//   * across all pages every pinned id appears exactly once (no repeat, no
//     skip);
//   * re-requesting the same cursor returns byte-identical rows;
//   * every row parses as `CanonicalFieldSchema`.

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient, WireResponse } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

const PAGE_LIMIT = 2;
const DISCOVERY_LIMIT = 5;
const MAX_PAGES = 20;

interface Page {
  rows: Array<{ externalId: string }>;
  nextCursor?: string;
  res: WireResponse;
}

function fail(detail: string): { id: 'P4'; pass: false; detail: string } {
  return { id: 'P4', pass: false, detail };
}

/** POST a search, validate the wire envelope + every row. */
async function search(
  client: ConformanceClient,
  body: Record<string, unknown>,
): Promise<{ ok: true; page: Page } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', body);
  if (res.status !== 200) return { ok: false, detail: statusDetail(res) };

  const parsed = readJson(res);
  if (!parsed.ok) return { ok: false, detail: `expected a JSON body, observed: ${parsed.detail}` };

  const rows = (parsed.body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      detail: `expected rows[] in the response, observed ${JSON.stringify(parsed.body).slice(0, 160)}`,
    };
  }
  for (const [idx, row] of rows.entries()) {
    const check = CanonicalFieldSchema.safeParse(row);
    if (!check.success) {
      return { ok: false, detail: `row ${idx} is not a valid canonical row — ${formatIssues(check.error)}` };
    }
  }
  const nextCursorRaw = (parsed.body as { nextCursor?: unknown }).nextCursor;
  const nextCursor =
    typeof nextCursorRaw === 'string' && nextCursorRaw.length > 0 ? nextCursorRaw : undefined;
  if (nextCursorRaw !== undefined && nextCursor === undefined) {
    return { ok: false, detail: `nextCursor, when present, must be a non-empty string; observed ${JSON.stringify(nextCursorRaw)}` };
  }
  return { ok: true, page: { rows: rows as Page['rows'], nextCursor, res } };
}

export const searchCase: ConformanceCase = {
  id: 'P4',
  kind: 'positive',
  async run(client) {
    // 1. Learn a few real ids from a small page.
    const discovery = await search(client, {
      criteria: { all: [] },
      mapping: STANDARD_MAPPING,
      limit: DISCOVERY_LIMIT,
    });
    if (!discovery.ok) return fail(discovery.detail);

    const ids = [...new Set(discovery.page.rows.map((r) => String(r.externalId)))];
    if (ids.length < PAGE_LIMIT + 1) {
      return fail(
        `precondition: need >= ${PAGE_LIMIT + 1} distinct candidates to exercise a non-final and a final page, observed ${ids.length}`,
      );
    }

    // 2. Pin the working set to exactly those ids — a bounded result set,
    //    independent of the connector's size.
    const criteria = { all: [{ field: 'externalId', op: 'in', values: ids }] };
    const query = { criteria, mapping: STANDARD_MAPPING, limit: PAGE_LIMIT };

    const pages: Page[] = [];
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let i = 0; i < MAX_PAGES; i++) {
      const body: Record<string, unknown> = { ...query };
      if (cursor !== undefined) body.cursor = cursor;
      const r = await search(client, body);
      if (!r.ok) return fail(r.detail);
      const page = r.page;
      pages.push(page);

      if (page.rows.length > PAGE_LIMIT) {
        return fail(`page ${i + 1}: returned ${page.rows.length} rows for limit ${PAGE_LIMIT}`);
      }

      const pageIds = page.rows.map((row) => String(row.externalId));

      // A non-final page (one that hands back a cursor) must be exactly full.
      if (page.nextCursor !== undefined && page.rows.length !== PAGE_LIMIT) {
        return fail(
          `page ${i + 1}: carries a nextCursor but holds ${page.rows.length} rows (expected exactly ${PAGE_LIMIT})`,
        );
      }

      // Cursor must advance: no id from this page may have been seen before.
      const repeats = pageIds.filter((id) => seen.includes(id));
      if (repeats.length > 0) {
        return fail(`page ${i + 1}: cursor did not advance — id(s) already returned reappeared: [${repeats.join(', ')}]`);
      }
      seen.push(...pageIds);

      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;

      if (i === MAX_PAGES - 1) {
        return fail(`pagination did not terminate within ${MAX_PAGES} pages for a ${ids.length}-row pinned set`);
      }
    }

    // 3. The cursor path must actually have been exercised: a >= 3-row set at
    //    limit 2 must span at least a non-final and a final page. A connector
    //    that never emits a nextCursor (or ignores the pinning filter and pages
    //    an unbounded set into a single short page) fails here.
    if (pages.length < 2) {
      return fail(
        `expected the ${ids.length}-id pinned set to span >= 2 pages at limit ${PAGE_LIMIT} (a nextCursor after the first page), observed ${pages.length}`,
      );
    }

    // 4. The final page carries no cursor (loop exits only on that).
    if (pages[pages.length - 1].nextCursor !== undefined) {
      return fail('expected the last page to carry no nextCursor, observed one');
    }

    // 5. Every pinned id appears exactly once across the pages — no skip, no
    //    duplicate.
    const seenSet = new Set(seen);
    if (seen.length !== seenSet.size) {
      return fail(`expected each id once; an id was returned on more than one page (${seen.length} rows, ${seenSet.size} distinct)`);
    }
    const missing = ids.filter((id) => !seenSet.has(id));
    const extra = seen.filter((id) => !ids.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      return fail(
        `expected the paged rows to be exactly the pinned set {${ids.join(', ')}}; missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
      );
    }

    // 6. Re-requesting the first cursor returns byte-identical rows.
    const firstCursor = pages[0].nextCursor!;
    const replayBody = { ...query, cursor: firstCursor };
    const replayA = await search(client, replayBody);
    const replayB = await search(client, replayBody);
    if (!replayA.ok) return fail(replayA.detail);
    if (!replayB.ok) return fail(replayB.detail);
    if (replayA.page.res.bodyText !== replayB.page.res.bodyText) {
      return fail('re-requesting the same cursor returned a different response body');
    }
    if (replayA.page.res.bodyText !== pages[1].res.bodyText) {
      return fail('re-requesting the first cursor did not reproduce the second page byte-for-byte');
    }

    return { id: 'P4', pass: true };
  },
};
