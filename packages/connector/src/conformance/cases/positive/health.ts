// P1 — `GET /health` returns 200 with a valid `HealthResponseSchema` body.
//
// conformance-spec.md, positive item 1. The platform pings `/health` before
// every activation and periodically after; a connector that answers the wrong
// shape here is treated as down.

import { HealthResponseSchema } from '@askdepth/audience-contract';
import type { ConformanceCase } from '../../runner';
import { formatIssues, readJson, statusDetail } from './_shared';

export const healthCase: ConformanceCase = {
  id: 'P1',
  kind: 'positive',
  async run(client) {
    const res = await client.get('/health');

    if (res.status !== 200) {
      return { id: 'P1', pass: false, detail: statusDetail(res) };
    }

    const parsed = readJson(res);
    if (!parsed.ok) {
      return { id: 'P1', pass: false, detail: `expected a JSON body, observed: ${parsed.detail}` };
    }

    const check = HealthResponseSchema.safeParse(parsed.body);
    if (!check.success) {
      return {
        id: 'P1',
        pass: false,
        detail: `expected a valid HealthResponseSchema body, observed schema errors — ${formatIssues(check.error)}`,
      };
    }

    return { id: 'P1', pass: true };
  },
};
