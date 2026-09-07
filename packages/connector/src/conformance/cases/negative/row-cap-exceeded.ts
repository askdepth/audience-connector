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
// `detail` names the failing check and the observed count or code.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient } from '../../client';

const MAPPING = { src_external_id: 'externalId', src_email: 'email' };
const CAP = 1000;
const OVER_CAP = 1001;
const MAX_PAGES = 200;

function fail(detail: string) {
  return { id: 'N6', pass: false, detail } as const;
}

async function search(
  client: ConformanceClient,
  limit: number,
  cursor?: string,
): Promise<
  | { ok: true; status: number; rows: unknown[]; nextCursor?: string; code?: string }
  | { ok: false; detail: string }
> {
  const body: Record<string, unknown> = { criteria: { all: [] }, mapping: MAPPING, limit };
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

export const rowCapExceededCase: ConformanceCase = {
  id: 'N6',
  kind: 'negative',
  async run(client) {
    // 1. limit over the cap → documented rejection, adapter untouched.
    const over = await search(client, OVER_CAP);
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

    // 2. A single at-cap request must not exceed the cap.
    const atCap = await search(client, CAP);
    if (!atCap.ok) return fail(atCap.detail);
    if (atCap.status !== 200) {
      return fail(`limit ${CAP}: expected HTTP 200, observed HTTP ${atCap.status}`);
    }
    if (atCap.rows.length > CAP) {
      return fail(
        `limit ${CAP}: a single response returned ${atCap.rows.length} rows — the ${CAP}-row cap was exceeded`,
      );
    }

    // 3. Paging hard at the cap — no individual page may exceed it.
    let cursor = atCap.nextCursor;
    let total = atCap.rows.length;
    let maxPage = atCap.rows.length;
    for (let pages = 1; cursor && pages <= MAX_PAGES; pages++) {
      const next = await search(client, CAP, cursor);
      if (!next.ok) return fail(next.detail);
      if (next.status !== 200) {
        return fail(`limit ${CAP} page ${pages + 1}: expected HTTP 200, observed HTTP ${next.status}`);
      }
      if (next.rows.length > CAP) {
        return fail(
          `limit ${CAP} page ${pages + 1}: response returned ${next.rows.length} rows — the ${CAP}-row cap was exceeded`,
        );
      }
      total += next.rows.length;
      maxPage = Math.max(maxPage, next.rows.length);
      cursor = next.nextCursor;
    }

    return {
      id: 'N6',
      pass: true,
      detail: `limit ${OVER_CAP} rejected as limit_exceeded; largest single response ${maxPage} row(s), ${total} row(s) total across pages — the ${CAP}-row cap held`,
    };
  },
};
