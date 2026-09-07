// P2 — `GET /schema` returns `columns` (postgres) or the hand-declared schema
// (rest).
//
// conformance-spec.md, positive item 2. Either adapter shape is the same wire
// contract: `{ columns: [{ name, type }, …] }`, and it must be non-empty — a
// connector that introspects nothing has nothing to map against.

import { SchemaResponseSchema } from '@askdepth/audience-contract';
import type { ConformanceCase } from '../../runner';
import { formatIssues, readJson, statusDetail } from './_shared';

export const schemaCase: ConformanceCase = {
  id: 'P2',
  kind: 'positive',
  async run(client) {
    const res = await client.get('/schema');

    if (res.status !== 200) {
      return { id: 'P2', pass: false, detail: statusDetail(res) };
    }

    const parsed = readJson(res);
    if (!parsed.ok) {
      return { id: 'P2', pass: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
    }

    const check = SchemaResponseSchema.safeParse(parsed.body);
    if (!check.success) {
      return {
        id: 'P2',
        pass: false,
        detail: `expected a valid SchemaResponseSchema body, observed schema errors — ${formatIssues(check.error)}`,
      };
    }

    if (check.data.columns.length === 0) {
      return {
        id: 'P2',
        pass: false,
        detail: 'expected a non-empty columns[] (postgres introspection or a hand-declared schema), observed columns: []',
      };
    }

    return { id: 'P2', pass: true };
  },
};
