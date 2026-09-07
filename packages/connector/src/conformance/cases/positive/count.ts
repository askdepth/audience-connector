// P3 — `POST /candidates/count` returns a non-negative integer for a valid
// query.
//
// conformance-spec.md, positive item 3. The query here is the trivial
// "everyone" query (`all: []`) — the point is the response *shape and sign*,
// not a particular number.

import { CountResponseSchema } from '@askdepth/audience-contract';
import type { ConformanceCase } from '../../runner';
import { formatIssues, readJson, statusDetail } from './_shared';

export const countCase: ConformanceCase = {
  id: 'P3',
  kind: 'positive',
  async run(client) {
    const res = await client.post('/candidates/count', { criteria: { all: [] }, mapping: {} });

    if (res.status !== 200) {
      return { id: 'P3', pass: false, detail: statusDetail(res) };
    }

    const parsed = readJson(res);
    if (!parsed.ok) {
      return { id: 'P3', pass: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
    }

    // Check the raw field first so a negative or fractional number produces a
    // "expected non-negative integer, observed X" detail rather than an
    // opaque schema dump.
    const raw = (parsed.body as { count?: unknown }).count;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      return {
        id: 'P3',
        pass: false,
        detail: `expected a non-negative integer count, observed ${JSON.stringify(raw)}`,
      };
    }

    const check = CountResponseSchema.safeParse(parsed.body);
    if (!check.success) {
      return {
        id: 'P3',
        pass: false,
        detail: `expected a valid CountResponseSchema body, observed schema errors — ${formatIssues(check.error)}`,
      };
    }

    return { id: 'P3', pass: true };
  },
};
