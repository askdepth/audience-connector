// P6 — attribute filters (`attr.*`) filter WITHOUT the attribute appearing in
// the response, unless it is separately mapped for display (master §4.3).
//
// conformance-spec.md, positive item 6. Neither mode hardcodes a connector's
// attribute schema:
//
//   * Default (no `--filter-only-attribute`): connector-agnostic. P6 pulls an
//     unfiltered page and reads the set of attributes the connector actually
//     projects under `row.attributes` — its *observed returnable* attributes,
//     each with a concrete scalar example value taken from a real row. It then
//     filters on one of them and proves the filter is honoured (200, count > 0,
//     page size == min(count, 1000)) and genuinely applied (every row still
//     carries that value). No attribute name or value is assumed. A returnable
//     attribute filtered on legitimately still appears in rows — that is the
//     "unless separately mapped for display" clause, not a leak. With zero
//     observed returnable attributes there is nothing to filter on, so P6
//     records an honest limited pass whose `detail` names the limitation.
//
//   * With one or more `--filter-only-attribute <name>[=<value>]`: those names
//     are the filter-only set — invisible by design, so P6 needs this one piece
//     of out-of-band knowledge. It confirms each declared attribute is absent
//     from every unfiltered row and is not silently returnable, then **actually
//     sends** an `attr.<name>` filter on the declared attribute: with the
//     supplied value, or a sentinel value that is very unlikely to match. It
//     asserts the connector accepts and processes the clause (200, a valid
//     `rows[]`, a non-negative integer `count`) and that the declared attribute
//     still appears in no returned row. When a value was supplied it also
//     asserts the filter narrowed the result (count > 0 and strictly below the
//     unfiltered count). If a returnable attribute also exists, it re-checks
//     absence under a real filter on that returnable attribute too.

import { CanonicalFieldSchema } from '@askdepth/audience-contract';
import type { ConformanceClient } from '../../client';
import type { ConformanceCase } from '../../runner';
import { STANDARD_MAPPING, formatIssues, readJson, statusDetail } from './_shared';

const NO_SUCH_VALUE = '__conformance_no_such_value__';

type Scalar = string | number | boolean;

type Row = {
  externalId: unknown;
  attributes?: Record<string, unknown>;
};

function isScalar(v: unknown): v is Scalar {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function fail(detail: string): { id: 'P6'; pass: false; detail: string } {
  return { id: 'P6', pass: false, detail };
}

function pass(detail: string): { id: 'P6'; pass: true; detail: string } {
  return { id: 'P6', pass: true, detail };
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

/**
 * Attribute keys the connector actually projects under `row.attributes` across
 * the page, each mapped to a concrete scalar example value from a real row
 * (the first scalar occurrence wins). These are the connector's *observed
 * returnable* attributes — learned from the wire, never assumed.
 */
function observedReturnable(rows: Row[]): Map<string, Scalar> {
  const seen = new Map<string, Scalar>();
  for (const row of rows) {
    if (!row.attributes) continue;
    for (const [k, v] of Object.entries(row.attributes)) {
      if (!seen.has(k) && isScalar(v)) seen.set(k, v);
    }
  }
  return seen;
}

// ── Mode A: declared filter-only attributes (--filter-only-attribute) ───────

async function runWithDeclaredFilterOnly(
  client: ConformanceClient,
  filterOnly: readonly string[],
  filterOnlyValues: Readonly<Record<string, string>>,
): Promise<{ id: 'P6'; pass: boolean; detail?: string }> {
  const mapping = STANDARD_MAPPING;

  // 1. An unfiltered page + its exact count. Establishes the returnable
  //    attributes actually projected, a first absence check for the declared
  //    filter-only set, and the baseline a narrowing filter must beat.
  const base = await search(client, { criteria: { all: [] }, mapping, limit: 1000 });
  if (!base.ok) return fail(base.detail);
  if (base.rows.length === 0) {
    return fail('precondition: expected an unfiltered search to return candidates, observed 0');
  }
  const baseCount = await count(client, { all: [] });
  if (!baseCount.ok) return fail(baseCount.detail);

  const returnable = observedReturnable(base.rows);

  for (const attr of filterOnly) {
    if (returnable.has(attr)) {
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

  // 2. Actually send an `attr.<declared>` filter on every declared filter-only
  //    attribute. This is the point of a filter-only attribute — that the
  //    connector accepts and processes a clause on it — and it must be probed
  //    directly, not inferred from a returnable attribute.
  const exercised: string[] = [];

  for (const attr of filterOnly) {
    const supplied = Object.prototype.hasOwnProperty.call(filterOnlyValues, attr);
    const value: Scalar = supplied ? filterOnlyValues[attr] : NO_SUCH_VALUE;
    const criteria = { all: [{ field: `attr.${attr}`, op: 'eq', value }] };

    const res = await search(client, { criteria, mapping, limit: 1000 });
    if (!res.ok) {
      return fail(
        `expected the connector to accept and process an attr.${attr} filter on its declared filter-only attribute, observed: ${res.detail}`,
      );
    }
    const c = await count(client, criteria);
    if (!c.ok) return fail(c.detail);
    if (!Number.isInteger(c.count) || c.count < 0) {
      return fail(
        `expected a non-negative integer count for attr.${attr} == ${JSON.stringify(value)}, observed ${JSON.stringify(c.count)}`,
      );
    }
    const expectedRows = Math.min(c.count, 1000);
    if (res.rows.length !== expectedRows) {
      return fail(
        `expected the page filtered on attr.${attr} to hold ${expectedRows} rows (count=${c.count}), observed ${res.rows.length}`,
      );
    }
    const leaked = leakedOn(res.rows, attr);
    if (leaked.length > 0) {
      return fail(
        `expected filter-only attribute "${attr}" to stay absent from every row of a search that filters on it, observed it present on: [${leaked.slice(0, 10).join(', ')}]`,
      );
    }

    if (supplied) {
      if (c.count <= 0) {
        return fail(
          `expected > 0 candidates at the supplied attr.${attr} == ${JSON.stringify(value)}, observed count ${c.count} (the filter matched nothing — is the value valid?)`,
        );
      }
      if (!(c.count < baseCount.count)) {
        return fail(
          `expected a filter on attr.${attr} == ${JSON.stringify(value)} to narrow the result below the unfiltered count ${baseCount.count}, observed ${c.count}`,
        );
      }
      exercised.push(
        `filtered on attr.${attr} == ${JSON.stringify(value)}: ${c.count} rows, subset of ${baseCount.count}, "${attr}" absent from every row`,
      );
    } else {
      exercised.push(
        `filtered on attr.${attr} == <sentinel>: accepted structurally (200, ${c.count} rows), "${attr}" absent from every row`,
      );
    }
  }

  // 3. If a returnable attribute also exists, re-check absence of the
  //    filter-only attributes under a real `attr.*` filter on that returnable
  //    attribute — and confirm the returnable value is echoed (filter applied,
  //    not ignored). This is additive: it must not be the only probe, and a
  //    connector with no returnable attribute must still have reached step 2.
  const probe = [...returnable.entries()][0];
  if (probe) {
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
    const mismatched = filtered.rows.filter(
      (r) => !has(r, probeAttr) || r.attributes?.[probeAttr] !== probeValue,
    );
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
    exercised.push(
      `also filtered on returnable attr.${probeAttr} == ${JSON.stringify(probeValue)}: echoed on every row, filter-only attr(s) absent`,
    );
  } else {
    exercised.push('connector projects no returnable attribute, so no display-echo half to check');
  }

  return pass(exercised.join('; '));
}

// ── Mode B: connector-agnostic, no flag ───────────────────────────────────

async function runStructural(
  client: ConformanceClient,
): Promise<{ id: 'P6'; pass: boolean; detail?: string }> {
  const mapping = STANDARD_MAPPING;

  // 1. An unfiltered page (identity mapping, small limit). Read the attributes
  //    the connector actually projects under `row.attributes`.
  const base = await search(client, { criteria: { all: [] }, mapping, limit: 50 });
  if (!base.ok) return fail(base.detail);
  if (base.rows.length === 0) {
    return fail('precondition: expected an unfiltered search to return candidates, observed 0');
  }

  const returnable = observedReturnable(base.rows);

  // 2. Nothing projected → nothing to filter on. Honest limited pass that names
  //    the limitation rather than a vacuous green.
  if (returnable.size === 0) {
    return pass(
      'connector projects no returnable attributes; attribute-filter behaviour not exercised ' +
        '(pass --filter-only-attribute to grade a filter-only attribute)',
    );
  }

  // 3. Filter on one observed returnable attribute using a value drawn from a
  //    real row. Prove the filter is honoured and genuinely applied.
  const [attr, value] = [...returnable.entries()][0];
  const criteria = { all: [{ field: `attr.${attr}`, op: 'eq', value }] };

  const filtered = await search(client, { criteria, mapping, limit: 1000 });
  if (!filtered.ok) return fail(filtered.detail);

  const c = await count(client, criteria);
  if (!c.ok) return fail(c.detail);
  if (c.count <= 0) {
    return fail(
      `precondition: expected > 0 candidates at attr.${attr} == ${JSON.stringify(value)} ` +
        `(value taken from a real unfiltered row), observed count ${c.count}`,
    );
  }
  const expectedRows = Math.min(c.count, 1000);
  if (filtered.rows.length !== expectedRows) {
    return fail(
      `expected the filtered page to hold ${expectedRows} rows (count=${c.count}), observed ${filtered.rows.length}`,
    );
  }

  const mismatched = filtered.rows.filter(
    (r) => !has(r, attr) || r.attributes?.[attr] !== value,
  );
  if (mismatched.length > 0) {
    return fail(
      `expected every row of a search filtered on attr.${attr} == ${JSON.stringify(value)} to carry ` +
        `attributes.${attr} == ${JSON.stringify(value)}, observed ${mismatched.length} row(s) without it ` +
        `(filter ignored, not applied)`,
    );
  }

  // 4. The "unless separately mapped for display" clause: `attr` here is
  //    returnable, so it legitimately still appears in rows — that is correct,
  //    not a leak. There is no filter-only attribute to check absence of in
  //    this path; --filter-only-attribute is required for that.
  return pass(
    `no --filter-only-attribute supplied; exercised attr.* filtering on the observed returnable ` +
      `attribute "${attr}": filtered on attr.${attr} == ${JSON.stringify(value)} → ${filtered.rows.length} ` +
      `rows == count ${c.count}, every row carries attributes.${attr} == ${JSON.stringify(value)} ` +
      `(a returnable attribute filtered on legitimately still appears — not a leak). ` +
      `Pass --filter-only-attribute to additionally grade a filter-only attribute's absence.`,
  );
}

export const attributeFiltersCase: ConformanceCase = {
  id: 'P6',
  kind: 'positive',
  async run(client, context) {
    const declared = context?.filterOnlyAttributes ?? [];
    const values = context?.filterOnlyAttributeValues ?? {};
    return declared.length > 0
      ? runWithDeclaredFilterOnly(client, declared, values)
      : runStructural(client);
  },
};
