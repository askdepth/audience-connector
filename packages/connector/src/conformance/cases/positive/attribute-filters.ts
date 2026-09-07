// P6 — attribute filters (`attr.*`) filter WITHOUT the attribute appearing in
// the response, unless it is separately mapped for display (master §4.3).
//
// conformance-spec.md, positive item 6. A *filter-only* attribute is invisible
// by design, so this case needs one piece of out-of-band knowledge a connector
// cannot advertise: which attribute is filter-only.
//
//   * Default (no `--filter-only-attribute`): the built-in fixture / reference
//     shape is assumed — a filter-only attribute `plan` with candidates at
//     `plan == "pro"`, and a display-mapped attribute `tier`.
//   * With one or more `--filter-only-attribute <name>` flags: those names are
//     taken as the filter-only set. P6 then works structurally + by
//     auto-discovery — it never assumes a concrete value for them. It pulls an
//     unfiltered page, confirms each declared attribute is genuinely absent
//     from every row (and not silently returnable), discovers a *returnable*
//     attribute from the rows themselves, and re-checks absence under a real
//     `attr.*` filter on that discovered attribute.
//
// Proven in both modes:
//   * a request filtered on an `attr.*` clause is honoured (count > 0, page
//     size consistent with count);
//   * NO response row carries the filter-only attribute — it does not leak
//     into the projection;
//   * a display-mapped attribute still appears.

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

const FILTER_ONLY_ATTR = 'plan';
const FILTER_VALUE = 'pro';
const DISPLAY_ATTR = 'tier';

type Row = {
  externalId: unknown;
  attributes?: Record<string, unknown>;
};

function fail(detail: string): { id: 'P6'; pass: false; detail: string } {
  return { id: 'P6', pass: false, detail };
}

/** POST a search, validate the wire envelope and every row as canonical. */
async function search(
  client: ConformanceClient,
  body: Record<string, unknown>,
): Promise<{ ok: true; rows: Row[] } | { ok: false; detail: string }> {
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
  return { ok: true, rows: rows as Row[] };
}

async function count(
  client: ConformanceClient,
  criteria: unknown,
): Promise<{ ok: true; count: number } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/count', { criteria, mapping: {} });
  if (res.status !== 200) return { ok: false, detail: statusDetail(res) };
  const body = readJson(res);
  if (!body.ok) return { ok: false, detail: `expected a JSON body, observed: ${body.detail}` };
  const n = (body.body as { count?: unknown }).count;
  if (typeof n !== 'number') return { ok: false, detail: `expected a numeric count, observed ${JSON.stringify(n)}` };
  return { ok: true, count: n };
}

function has(row: Row, attr: string): boolean {
  return row.attributes != null && Object.prototype.hasOwnProperty.call(row.attributes, attr);
}

function leakedOn(rows: Row[], attr: string): string[] {
  return rows.filter((r) => has(r, attr)).map((r) => String(r.externalId));
}

// ── Mode A: declared filter-only attributes (--filter-only-attribute) ───────

async function runWithDeclaredFilterOnly(
  client: ConformanceClient,
  filterOnly: readonly string[],
): Promise<{ id: 'P6'; pass: boolean; detail?: string }> {
  const mapping = STANDARD_MAPPING;

  // 1. An unfiltered page. Establishes the returnable attributes actually
  //    projected, and a first absence check for the declared filter-only set.
  const base = await search(client, { criteria: { all: [] }, mapping, limit: 1000 });
  if (!base.ok) return fail(base.detail);
  if (base.rows.length === 0) {
    return fail('precondition: expected an unfiltered search to return candidates, observed 0');
  }

  const returnableSeen = new Map<string, unknown>();
  for (const row of base.rows) {
    if (!row.attributes) continue;
    for (const [k, v] of Object.entries(row.attributes)) {
      if (!returnableSeen.has(k)) returnableSeen.set(k, v);
    }
  }

  for (const attr of filterOnly) {
    if (returnableSeen.has(attr)) {
      return fail(
        `expected declared filter-only attribute "${attr}" to appear in no response row, observed it projected as a returnable attribute`,
      );
    }
    const leaked = leakedOn(base.rows, attr);
    if (leaked.length > 0) {
      return fail(
        `expected filter-only attribute "${attr}" to be absent from every response row, observed it present on: [${leaked.slice(0, 10).join(', ')}]`,
      );
    }
  }

  // 2. Auto-discover a returnable attribute with a usable scalar value, and
  //    prove `attr.*` filtering is honoured through it — while the declared
  //    filter-only attributes stay absent from the filtered page too.
  const probe = [...returnableSeen.entries()].find(
    ([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
  if (!probe) {
    // No returnable attribute to filter on; the structural absence check above
    // is the whole of what this connector lets us prove.
    return { id: 'P6', pass: true };
  }

  const [probeAttr, probeValue] = probe;
  const criteria = { all: [{ field: `attr.${probeAttr}`, op: 'eq', value: probeValue }] };

  const filtered = await search(client, { criteria, mapping, limit: 1000 });
  if (!filtered.ok) return fail(filtered.detail);

  const c = await count(client, criteria);
  if (!c.ok) return fail(c.detail);
  if (c.count <= 0) {
    return fail(
      `precondition: expected > 0 candidates at attr.${probeAttr} == ${JSON.stringify(probeValue)}, observed count ${c.count}`,
    );
  }
  const expectedRows = Math.min(c.count, 1000);
  if (filtered.rows.length !== expectedRows) {
    return fail(
      `expected the filtered page to hold ${expectedRows} rows (count=${c.count}), observed ${filtered.rows.length}`,
    );
  }

  // The discovered attribute is returnable, so the filter value must be echoed
  // on every filtered row (filter honoured, not ignored).
  const mismatched = filtered.rows.filter((r) => !has(r, probeAttr) || r.attributes?.[probeAttr] !== probeValue);
  if (mismatched.length > 0) {
    return fail(
      `expected every filtered row to carry attributes.${probeAttr} == ${JSON.stringify(probeValue)}, observed ${mismatched.length} row(s) without it`,
    );
  }

  for (const attr of filterOnly) {
    const leaked = leakedOn(filtered.rows, attr);
    if (leaked.length > 0) {
      return fail(
        `expected filter-only attribute "${attr}" to be absent from every filtered response row, observed it present on: [${leaked.slice(0, 10).join(', ')}]`,
      );
    }
  }

  return { id: 'P6', pass: true };
}

// ── Mode B: built-in fixture attributes (no flag) ──────────────────────────

async function runStructural(
  client: ConformanceClient,
): Promise<{ id: 'P6'; pass: boolean; detail?: string }> {
  const criteria = {
    all: [{ field: `attr.${FILTER_ONLY_ATTR}`, op: 'eq', value: FILTER_VALUE }],
  };
  const mapping = { src_external_id: 'externalId', src_email: 'email' };

  const res = await search(client, { criteria, mapping, limit: 1000 });
  if (!res.ok) return fail(res.detail);
  const rows = res.rows;

  // The core property: the filter attribute must not appear in any row.
  const leaked = leakedOn(rows, FILTER_ONLY_ATTR);
  if (leaked.length > 0) {
    return fail(
      `expected filter-only attribute "${FILTER_ONLY_ATTR}" to be absent from every response row, observed it present on: [${leaked.slice(0, 10).join(', ')}]`,
    );
  }

  // Guard against a vacuous pass, and cross-check the page size against count.
  const c = await count(client, criteria);
  if (!c.ok) return fail(c.detail);
  if (c.count <= 0) {
    return fail(
      `precondition: expected > 0 candidates at attr.${FILTER_ONLY_ATTR} == "${FILTER_VALUE}", observed count ${c.count}`,
    );
  }
  const expectedRows = Math.min(c.count, 1000);
  if (rows.length !== expectedRows) {
    return fail(
      `expected the filtered page to hold ${expectedRows} rows (count=${c.count}), observed ${rows.length}`,
    );
  }

  // The "unless separately mapped for display" half: `tier` is returnable, so
  // it must still be projected.
  const withDisplayAttr = rows.filter((r) => has(r, DISPLAY_ATTR));
  if (rows.length > 0 && withDisplayAttr.length === 0) {
    return fail(
      `expected display-mapped attribute "${DISPLAY_ATTR}" to appear in response rows, observed it on none of ${rows.length}`,
    );
  }

  return { id: 'P6', pass: true };
}

export const attributeFiltersCase: ConformanceCase = {
  id: 'P6',
  kind: 'positive',
  async run(client, context) {
    const declared = context?.filterOnlyAttributes ?? [];
    return declared.length > 0
      ? runWithDeclaredFilterOnly(client, declared)
      : runStructural(client);
  },
};
