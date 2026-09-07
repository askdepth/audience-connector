// P7 — `suppressExternalIds` excludes the named ids from results.
//
// conformance-spec.md, positive item 7. Size-agnostic: cursorless search is
// randomly sub-sampled per pull, so a page pulled twice is not the same page.
// The case therefore learns a handful of real ids from one small page, pins
// the working set to exactly those ids with an `externalId IN` clause (bounded,
// order-independent, unaffected by how many rows the connector holds), then
// suppresses some of them and asserts — via BOTH `search` and `count` — that
// the suppressed ids are gone and the total drops by exactly the number
// suppressed. It never sends N6's at-cap probe shape (its search carries a
// non-empty `criteria.all`).

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

const SUBJECT_SIZE = 4; // distinct ids to pin
const SUPPRESS_SIZE = 2; // of those, how many to suppress

function fail(detail: string): { id: 'P7'; pass: false; detail: string } {
  return { id: 'P7', pass: false, detail };
}

async function count(
  client: ConformanceClient,
  criteria: Record<string, unknown>,
): Promise<{ ok: true; count: number } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/count', { criteria, mapping: {} });
  if (res.status !== 200) return { ok: false, detail: statusDetail(res) };
  const parsed = readJson(res);
  if (!parsed.ok) return { ok: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
  const n = (parsed.body as { count?: unknown }).count;
  if (typeof n !== 'number') return { ok: false, detail: `expected a numeric count, observed ${JSON.stringify(n)}` };
  return { ok: true, count: n };
}

async function searchIds(
  client: ConformanceClient,
  body: Record<string, unknown>,
): Promise<{ ok: true; ids: string[] } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', body);
  if (res.status !== 200) return { ok: false, detail: statusDetail(res) };
  const parsed = readJson(res);
  if (!parsed.ok) return { ok: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
  const rows = (parsed.body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return { ok: false, detail: 'expected rows[] in the response' };
  for (const [idx, row] of rows.entries()) {
    const check = CanonicalFieldSchema.safeParse(row);
    if (!check.success) {
      return { ok: false, detail: `row ${idx} is not a valid canonical row — ${formatIssues(check.error)}` };
    }
  }
  return { ok: true, ids: rows.map((r) => String((r as { externalId: unknown }).externalId)) };
}

export const suppressExternalIdsCase: ConformanceCase = {
  id: 'P7',
  kind: 'positive',
  async run(client) {
    // 1. Learn a handful of real ids from a small page.
    const discovered = await searchIds(client, {
      criteria: { all: [] },
      mapping: STANDARD_MAPPING,
      limit: SUBJECT_SIZE + 4,
    });
    if (!discovered.ok) return fail(discovered.detail);

    const subject = [...new Set(discovered.ids)].slice(0, SUBJECT_SIZE);
    if (subject.length < SUBJECT_SIZE) {
      return fail(
        `precondition: need >= ${SUBJECT_SIZE} distinct candidates to prove suppression, observed ${subject.length}`,
      );
    }

    // 2. Pin the working set to exactly those ids — bounded, size-independent.
    const inClause = { field: 'externalId', op: 'in', values: subject };
    const before = await count(client, { all: [inClause] });
    if (!before.ok) return fail(before.detail);
    if (before.count !== subject.length) {
      return fail(
        `expected count ${subject.length} for the pinned externalId IN set, observed ${before.count} — the connector is not honouring the externalId filter`,
      );
    }

    const suppressed = subject.slice(0, SUPPRESS_SIZE);
    const survivors = subject.slice(SUPPRESS_SIZE);
    const criteria = { all: [inClause], suppressExternalIds: suppressed };

    // 3. search: exactly the survivors, none of the suppressed.
    const after = await searchIds(client, { criteria, mapping: STANDARD_MAPPING, limit: 1000 });
    if (!after.ok) return fail(after.detail);

    const returned = new Set(after.ids);
    const stillPresent = suppressed.filter((id) => returned.has(id));
    if (stillPresent.length > 0) {
      return fail(`expected suppressed ids to be absent, observed present in results: [${stillPresent.join(', ')}]`);
    }
    const missingSurvivors = survivors.filter((id) => !returned.has(id));
    if (missingSurvivors.length > 0 || after.ids.length !== survivors.length) {
      return fail(
        `expected exactly the ${survivors.length} un-suppressed id(s) {${survivors.join(', ')}}, observed {${after.ids.join(', ')}}`,
      );
    }

    // 4. count drops by exactly the number suppressed.
    const afterCount = await count(client, criteria);
    if (!afterCount.ok) return fail(afterCount.detail);
    if (afterCount.count !== before.count - suppressed.length) {
      return fail(
        `expected count to drop by ${suppressed.length} (${before.count} → ${before.count - suppressed.length}), observed ${afterCount.count}`,
      );
    }

    return { id: 'P7', pass: true };
  },
};
