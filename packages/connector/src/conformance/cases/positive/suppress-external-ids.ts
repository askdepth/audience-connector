// P7 — `suppressExternalIds` excludes the named ids from results.
//
// conformance-spec.md, positive item 7. The case learns real ids from an
// unfiltered search, suppresses three of them, and asserts: none of the three
// come back, and both `search` and `count` drop by exactly three.

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

async function countAll(
  client: ConformanceClient,
  criteria: Record<string, unknown>,
): Promise<{ ok: true; count: number } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/count', { criteria, mapping: {} });
  if (res.status !== 200) return { ok: false, detail: statusDetail(res) };
  const parsed = readJson(res);
  if (!parsed.ok) return { ok: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
  const count = (parsed.body as { count?: unknown }).count;
  if (typeof count !== 'number') return { ok: false, detail: `expected a numeric count, observed ${JSON.stringify(count)}` };
  return { ok: true, count };
}

export const suppressExternalIdsCase: ConformanceCase = {
  id: 'P7',
  kind: 'positive',
  async run(client) {
    const baseSearch = await client.post('/candidates/search', {
      criteria: { all: [] },
      mapping: STANDARD_MAPPING,
      limit: 1000,
    });
    if (baseSearch.status !== 200) return { id: 'P7', pass: false, detail: statusDetail(baseSearch) };
    const baseParsed = readJson(baseSearch);
    if (!baseParsed.ok) return { id: 'P7', pass: false, detail: `expected a JSON body, observed: ${baseParsed.detail}` };
    const baseRows = (baseParsed.body as { rows?: unknown }).rows;
    if (!Array.isArray(baseRows)) return { id: 'P7', pass: false, detail: 'expected rows[] in the baseline search response' };

    const allIds = baseRows.map((r) => String((r as { externalId: unknown }).externalId));
    if (allIds.length < 4) {
      return {
        id: 'P7',
        pass: false,
        detail: `precondition: need >= 4 candidates to prove suppression, observed ${allIds.length}`,
      };
    }
    if (allIds.length >= 1000) {
      return { id: 'P7', pass: false, detail: `precondition: baseline (${allIds.length}) fills the 1000 cap; row-count delta is unreliable` };
    }

    const suppressed = [...allIds].sort().slice(0, 3);

    const before = await countAll(client, { all: [] });
    if (!before.ok) return { id: 'P7', pass: false, detail: before.detail };

    const criteria = { all: [], suppressExternalIds: suppressed };
    const res = await client.post('/candidates/search', { criteria, mapping: STANDARD_MAPPING, limit: 1000 });
    if (res.status !== 200) return { id: 'P7', pass: false, detail: statusDetail(res) };
    const parsed = readJson(res);
    if (!parsed.ok) return { id: 'P7', pass: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
    const rows = (parsed.body as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return { id: 'P7', pass: false, detail: 'expected rows[] in the response' };

    for (const [idx, row] of rows.entries()) {
      const check = CanonicalFieldSchema.safeParse(row);
      if (!check.success) {
        return { id: 'P7', pass: false, detail: `row ${idx} is not a valid canonical row — ${formatIssues(check.error)}` };
      }
    }

    const returnedIds = new Set(rows.map((r) => String((r as { externalId: unknown }).externalId)));
    const stillPresent = suppressed.filter((id) => returnedIds.has(id));
    if (stillPresent.length > 0) {
      return {
        id: 'P7',
        pass: false,
        detail: `expected suppressed ids to be absent, observed present in results: [${stillPresent.join(', ')}]`,
      };
    }

    if (rows.length !== allIds.length - suppressed.length) {
      return {
        id: 'P7',
        pass: false,
        detail: `expected ${allIds.length - suppressed.length} rows after suppressing ${suppressed.length}, observed ${rows.length}`,
      };
    }

    const after = await countAll(client, criteria);
    if (!after.ok) return { id: 'P7', pass: false, detail: after.detail };
    if (after.count !== before.count - suppressed.length) {
      return {
        id: 'P7',
        pass: false,
        detail: `expected count to drop by ${suppressed.length} (${before.count} → ${before.count - suppressed.length}), observed ${after.count}`,
      };
    }

    return { id: 'P7', pass: true };
  },
};
