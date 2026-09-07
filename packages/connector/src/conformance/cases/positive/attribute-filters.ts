// P6 — attribute filters (`attr.*`) filter WITHOUT the attribute appearing in
// the response, unless it is separately mapped for display (master §4.3).
//
// conformance-spec.md, positive item 6. This case needs one piece of
// out-of-band knowledge that a connector cannot advertise (a *filter-only*
// attribute is invisible by design): it assumes the connector under test
// exposes a filter-only attribute `plan` with at least one candidate at
// `plan == "pro"`, and a display-mapped attribute `tier`. The reference /
// fixture connector is configured that way. Generalising this (per-connector
// attribute config for the runner) is left to a later stage.
//
// Proven here:
//   * a request filtered on `attr.plan` is honoured (count > 0, page size
//     consistent with count);
//   * NO response row carries `attributes.plan` — the filter attribute does
//     not leak into the projection;
//   * `attributes.tier`, which *is* mapped for display, still appears.

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceCase } from '../../runner';
import { formatIssues, readJson, statusDetail } from './_shared';

const FILTER_ONLY_ATTR = 'plan';
const FILTER_VALUE = 'pro';
const DISPLAY_ATTR = 'tier';

export const attributeFiltersCase: ConformanceCase = {
  id: 'P6',
  kind: 'positive',
  async run(client) {
    const criteria = {
      all: [{ field: `attr.${FILTER_ONLY_ATTR}`, op: 'eq', value: FILTER_VALUE }],
    };
    const mapping = { src_external_id: 'externalId', src_email: 'email' };

    const res = await client.post('/candidates/search', { criteria, mapping, limit: 1000 });
    if (res.status !== 200) return { id: 'P6', pass: false, detail: statusDetail(res) };

    const parsed = readJson(res);
    if (!parsed.ok) return { id: 'P6', pass: false, detail: `expected a JSON body, observed: ${parsed.detail}` };

    const rows = (parsed.body as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) return { id: 'P6', pass: false, detail: 'expected rows[] in the response' };

    for (const [idx, row] of rows.entries()) {
      const check = CanonicalFieldSchema.safeParse(row);
      if (!check.success) {
        return { id: 'P6', pass: false, detail: `row ${idx} is not a valid canonical row — ${formatIssues(check.error)}` };
      }
    }

    // The core property: the filter attribute must not appear in any row.
    const leaked = rows
      .filter((r) => {
        const attrs = (r as { attributes?: Record<string, unknown> }).attributes;
        return attrs != null && Object.prototype.hasOwnProperty.call(attrs, FILTER_ONLY_ATTR);
      })
      .map((r) => String((r as { externalId: unknown }).externalId));
    if (leaked.length > 0) {
      return {
        id: 'P6',
        pass: false,
        detail: `expected filter-only attribute "${FILTER_ONLY_ATTR}" to be absent from every response row, observed it present on: [${leaked.slice(0, 10).join(', ')}]`,
      };
    }

    // Guard against a vacuous pass, and cross-check the page size against count.
    const countRes = await client.post('/candidates/count', { criteria, mapping: {} });
    if (countRes.status !== 200) return { id: 'P6', pass: false, detail: statusDetail(countRes) };
    const countBody = readJson(countRes);
    if (!countBody.ok) return { id: 'P6', pass: false, detail: `expected a JSON body, observed: ${countBody.detail}` };
    const count = (countBody.body as { count?: unknown }).count;

    if (typeof count !== 'number' || count <= 0) {
      return {
        id: 'P6',
        pass: false,
        detail: `precondition: expected > 0 candidates at attr.${FILTER_ONLY_ATTR} == "${FILTER_VALUE}", observed count ${JSON.stringify(count)}`,
      };
    }
    const expectedRows = Math.min(count, 1000);
    if (rows.length !== expectedRows) {
      return {
        id: 'P6',
        pass: false,
        detail: `expected the filtered page to hold ${expectedRows} rows (count=${count}), observed ${rows.length}`,
      };
    }

    // The "unless separately mapped for display" half: `tier` is returnable,
    // so it must still be projected.
    const withDisplayAttr = rows.filter((r) => {
      const attrs = (r as { attributes?: Record<string, unknown> }).attributes;
      return attrs != null && Object.prototype.hasOwnProperty.call(attrs, DISPLAY_ATTR);
    });
    if (rows.length > 0 && withDisplayAttr.length === 0) {
      return {
        id: 'P6',
        pass: false,
        detail: `expected display-mapped attribute "${DISPLAY_ATTR}" to appear in response rows, observed it on none of ${rows.length}`,
      };
    }

    return { id: 'P6', pass: true };
  },
};
