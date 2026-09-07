// P5 — `externalId IN [...]` criteria return the correct intersection.
//
// conformance-spec.md, positive item 5. The case learns three real ids from an
// unfiltered search, adds one id that is deliberately absent, and asserts the
// filtered result is exactly the three that exist — both via `search` and via
// `count`.

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

const ABSENT_ID = '__conformance_absent_id__';

async function idsFromUnfilteredSearch(
  client: ConformanceClient,
): Promise<{ ok: true; ids: string[] } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', {
    criteria: { all: [] },
    mapping: STANDARD_MAPPING,
    limit: 1000,
  });
  if (res.status !== 200) return { ok: false, detail: statusDetail(res) };
  const parsed = readJson(res);
  if (!parsed.ok) return { ok: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
  const rows = (parsed.body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return { ok: false, detail: 'expected rows[] in the baseline search response' };
  return { ok: true, ids: rows.map((r) => String((r as { externalId: unknown }).externalId)) };
}

export const externalIdInCase: ConformanceCase = {
  id: 'P5',
  kind: 'positive',
  async run(client) {
    const baseline = await idsFromUnfilteredSearch(client);
    if (!baseline.ok) return { id: 'P5', pass: false, detail: baseline.detail };

    if (baseline.ids.includes(ABSENT_ID)) {
      return { id: 'P5', pass: false, detail: `precondition: "${ABSENT_ID}" unexpectedly exists in the fixture` };
    }
    if (baseline.ids.length < 3) {
      return {
        id: 'P5',
        pass: false,
        detail: `precondition: need >= 3 candidates to test an intersection, observed ${baseline.ids.length}`,
      };
    }

    const wanted = [...baseline.ids].sort().slice(0, 3);
    const requestedValues = [...wanted, ABSENT_ID];
    const criteria = { all: [{ field: 'externalId', op: 'in', values: requestedValues }] };

    const searchRes = await client.post('/candidates/search', {
      criteria,
      mapping: STANDARD_MAPPING,
      limit: 1000,
    });
    if (searchRes.status !== 200) return { id: 'P5', pass: false, detail: statusDetail(searchRes) };
    const parsed = readJson(searchRes);
    if (!parsed.ok) return { id: 'P5', pass: false, detail: `expected a JSON body, observed: ${parsed.detail}` };

    const rows = (parsed.body as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return { id: 'P5', pass: false, detail: 'expected rows[] in the response' };
    for (const [idx, row] of rows.entries()) {
      const check = CanonicalFieldSchema.safeParse(row);
      if (!check.success) {
        return { id: 'P5', pass: false, detail: `row ${idx} is not a valid canonical row — ${formatIssues(check.error)}` };
      }
    }

    const got = new Set(rows.map((r) => String((r as { externalId: unknown }).externalId)));
    const expected = new Set(wanted);
    const missing = wanted.filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !expected.has(id));
    if (missing.length > 0 || extra.length > 0) {
      return {
        id: 'P5',
        pass: false,
        detail: `expected exactly {${wanted.join(', ')}}, observed {${[...got].join(', ')}} (missing: [${missing.join(', ')}], unexpected: [${extra.join(', ')}])`,
      };
    }

    const countRes = await client.post('/candidates/count', { criteria, mapping: {} });
    if (countRes.status !== 200) return { id: 'P5', pass: false, detail: statusDetail(countRes) };
    const countBody = readJson(countRes);
    if (!countBody.ok) return { id: 'P5', pass: false, detail: `expected a JSON body, observed: ${countBody.detail}` };
    const count = (countBody.body as { count?: unknown }).count;
    if (count !== wanted.length) {
      return {
        id: 'P5',
        pass: false,
        detail: `expected count ${wanted.length} for the same externalId IN criteria, observed ${JSON.stringify(count)}`,
      };
    }

    return { id: 'P5', pass: true };
  },
};
