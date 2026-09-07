// P4 — `POST /candidates/search` respects `limit` and returns a `cursor` when
// more rows exist.
//
// conformance-spec.md, positive item 4. The wire field is `nextCursor`
// (handler response shape `{ rows, nextCursor }`); "cursor" in the spec text
// refers to that token. Two things are proven:
//   * a page is never larger than `limit`, and is exactly `limit` when the
//     result set is bigger — with a `nextCursor` string to continue;
//   * a page that returns the whole result set carries no `nextCursor`.
// A follow-up request with the cursor must advance (different rows).

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

interface Page {
  rows: Array<{ externalId: string }>;
  nextCursor?: unknown;
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
    return { ok: false, detail: `expected rows[] in the response, observed ${JSON.stringify(parsed.body).slice(0, 160)}` };
  }
  for (const [idx, row] of rows.entries()) {
    const check = CanonicalFieldSchema.safeParse(row);
    if (!check.success) {
      return { ok: false, detail: `row ${idx} is not a valid canonical row — ${formatIssues(check.error)}` };
    }
  }
  return { ok: true, page: { rows: rows as Page['rows'], nextCursor: (parsed.body as Page).nextCursor } };
}

export const searchCase: ConformanceCase = {
  id: 'P4',
  kind: 'positive',
  async run(client) {
    const query = { criteria: { all: [] }, mapping: STANDARD_MAPPING };

    // Learn the size of the "everyone" result set from the connector itself.
    const baseline = await search(client, { ...query, limit: 1000 });
    if (!baseline.ok) return { id: 'P4', pass: false, detail: baseline.detail };
    const total = baseline.page.rows.length;

    if (total < 2) {
      return {
        id: 'P4',
        pass: false,
        detail: `precondition: need >= 2 candidates to exercise pagination, observed ${total}`,
      };
    }
    if (total >= 1000) {
      return {
        id: 'P4',
        pass: false,
        detail: `precondition: fixture result set (${total}) fills the 1000 cap; cannot prove "no cursor when complete"`,
      };
    }
    if (baseline.page.nextCursor !== undefined) {
      return {
        id: 'P4',
        pass: false,
        detail: `expected no nextCursor when all ${total} rows are returned (limit 1000), observed ${JSON.stringify(baseline.page.nextCursor)}`,
      };
    }

    // A single-row page: must be exactly 1 row and must hand back a cursor.
    const page1 = await search(client, { ...query, limit: 1 });
    if (!page1.ok) return { id: 'P4', pass: false, detail: page1.detail };
    if (page1.page.rows.length !== 1) {
      return {
        id: 'P4',
        pass: false,
        detail: `expected exactly 1 row for limit=1, observed ${page1.page.rows.length}`,
      };
    }
    if (typeof page1.page.nextCursor !== 'string' || page1.page.nextCursor.length === 0) {
      return {
        id: 'P4',
        pass: false,
        detail: `expected a nextCursor string (more rows exist: ${total} > 1), observed ${JSON.stringify(page1.page.nextCursor)}`,
      };
    }

    // Following the cursor must advance to a different row.
    const page2 = await search(client, { ...query, limit: 1, cursor: page1.page.nextCursor });
    if (!page2.ok) return { id: 'P4', pass: false, detail: page2.detail };
    if (page2.page.rows.length !== 1) {
      return {
        id: 'P4',
        pass: false,
        detail: `expected exactly 1 row for the second page, observed ${page2.page.rows.length}`,
      };
    }
    if (page2.page.rows[0].externalId === page1.page.rows[0].externalId) {
      return {
        id: 'P4',
        pass: false,
        detail: `expected the cursor to advance past "${page1.page.rows[0].externalId}", observed the same row again`,
      };
    }

    return { id: 'P4', pass: true };
  },
};
