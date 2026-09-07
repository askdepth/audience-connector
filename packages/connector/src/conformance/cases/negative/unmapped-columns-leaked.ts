// N3 — a connector FAILS conformance if it "returns unmapped columns"
// (docs/conformance-spec.md, negative item 3).
//
// Normal polarity: a correct connector PASSES. A canonical result row is a
// closed shape (master §4.3): a connector maps its store columns to the
// canonical fields and returns nothing else. A row carrying a key that is
// neither a canonical field nor something the connector itself declares in
// `/schema` is an unmapped column that leaked — most often a raw `SELECT *`.
//
// Two modes:
//
//   * **Structural (always).** Every key of every `/candidates/search` row must
//     be a canonical field, or — for a connector whose row keys mirror its
//     store column names — present in the connector's own `/schema` `columns`.
//     Anything else is flagged, naming the key. This is the weaker check: a
//     connector that over-returns a store column it *also* lists in `/schema`
//     slips through, which is why the out-of-band list exists.
//
//   * **Declared (when `--unmapped-column <name>` was given).** The operator
//     has named store columns that exist in the backing data but are
//     intentionally unmapped and sensitive; they must appear in NO response.
//     The case asserts each declared name is absent from `/schema` and from
//     every `/candidates/search` response body (raw text — catches a nested or
//     renamed leak too).
//
// Only the wire is exercised; the out-of-band list is the sole extra input and
// it arrives through {@link ConformanceCaseContext}, never over the protocol.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient, WireResponse } from '../../client';

// The closed set of canonical row keys (types.ts `CanonicalRow`). Re-declared
// here as literals — a conformance case imports no connector internals.
const CANONICAL_ROW_KEYS: ReadonlySet<string> = new Set([
  'externalId',
  'email',
  'name',
  'segment',
  'signupAt',
  'isActive',
  'contactable',
  'attributes',
]);

// A minimal mapping (identity fields only) and a display mapping (adds a couple
// of projected columns). A connector that leaks does so under both.
const MINIMAL_MAPPING = { src_external_id: 'externalId', src_email: 'email' };
const DISPLAY_MAPPING = {
  src_external_id: 'externalId',
  src_email: 'email',
  src_name: 'name',
  src_segment: 'segment',
  src_signup: 'signupAt',
};

interface SearchProbe {
  label: string;
  res: WireResponse;
  rows: Array<Record<string, unknown>>;
}

function fail(detail: string) {
  return { id: 'N3', pass: false, detail } as const;
}

async function schemaColumnNames(
  client: ConformanceClient,
): Promise<{ ok: true; names: Set<string> } | { ok: false; detail: string }> {
  const res = await client.get('/schema');
  if (res.status !== 200) {
    return { ok: false, detail: `GET /schema returned HTTP ${res.status}: "${res.bodyText.slice(0, 160)}"` };
  }
  let body: unknown;
  try {
    body = res.json();
  } catch {
    return { ok: false, detail: `GET /schema body is not JSON: "${res.bodyText.slice(0, 160)}"` };
  }
  const columns = (body as { columns?: unknown }).columns;
  if (!Array.isArray(columns)) {
    return { ok: false, detail: `GET /schema has no columns[]: "${JSON.stringify(body).slice(0, 160)}"` };
  }
  const names = new Set<string>();
  for (const c of columns) {
    const n = (c as { name?: unknown }).name;
    if (typeof n === 'string') names.add(n);
  }
  return { ok: true, names };
}

async function searchProbe(
  client: ConformanceClient,
  label: string,
  mapping: Record<string, string>,
): Promise<{ ok: true; probe: SearchProbe } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', {
    criteria: { all: [] },
    mapping,
    limit: 100,
  });
  if (res.status !== 200) {
    return { ok: false, detail: `${label}: expected HTTP 200, observed ${res.status}: "${res.bodyText.slice(0, 160)}"` };
  }
  let body: unknown;
  try {
    body = res.json();
  } catch {
    return { ok: false, detail: `${label}: response body is not JSON: "${res.bodyText.slice(0, 160)}"` };
  }
  const rows = (body as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    return { ok: false, detail: `${label}: no rows[] in the response: "${JSON.stringify(body).slice(0, 160)}"` };
  }
  return { ok: true, probe: { label, res, rows: rows as Array<Record<string, unknown>> } };
}

export const unmappedColumnsLeakedCase: ConformanceCase = {
  id: 'N3',
  kind: 'negative',
  async run(client, context) {
    const declared = [...(context?.unmappedColumns ?? [])];

    const schema = await schemaColumnNames(client);
    if (!schema.ok) return fail(schema.detail);
    const schemaCols = schema.names;

    // 1. Declared sensitive columns must not be exposed by /schema itself.
    for (const col of declared) {
      if (schemaCols.has(col)) {
        return fail(
          `column "${col}" was declared unmapped and sensitive (--unmapped-column), yet GET /schema lists it — it must appear in no response`,
        );
      }
    }

    const probes: SearchProbe[] = [];
    for (const [label, mapping] of [
      ['POST /candidates/search (identity mapping)', MINIMAL_MAPPING],
      ['POST /candidates/search (display mapping)', DISPLAY_MAPPING],
    ] as const) {
      const p = await searchProbe(client, label, mapping);
      if (!p.ok) return fail(p.detail);
      probes.push(p.probe);
    }

    let rowsSeen = 0;
    for (const { label, res, rows } of probes) {
      rowsSeen += rows.length;

      // 2. Declared sensitive columns must not appear anywhere in the body.
      for (const col of declared) {
        if (res.bodyText.includes(col)) {
          return fail(
            `${label}: response body contains the declared unmapped column "${col}" — a mapped, capped projection must never expose it`,
          );
        }
      }

      // 3. Structural: no foreign top-level key on any row.
      for (const [idx, row] of rows.entries()) {
        if (typeof row !== 'object' || row === null) {
          return fail(`${label}: row ${idx} is not an object: ${JSON.stringify(row).slice(0, 120)}`);
        }
        for (const key of Object.keys(row)) {
          if (CANONICAL_ROW_KEYS.has(key)) continue;
          if (schemaCols.has(key)) {
            // A store column that is also in /schema — the weaker check cannot
            // prove intent, but with an out-of-band list we can.
            if (declared.includes(key)) {
              return fail(
                `${label}: row ${idx} ("${String(row.externalId)}") returns the declared unmapped column "${key}"`,
              );
            }
            return fail(
              `${label}: row ${idx} ("${String(row.externalId)}") returns "${key}", a store column from /schema that is not a canonical field — an unmapped column leaked (SELECT *?)`,
            );
          }
          return fail(
            `${label}: row ${idx} ("${String(row.externalId)}") has key "${key}", which is neither a canonical field nor a column declared in /schema — an unmapped column leaked`,
          );
        }
      }
    }

    if (declared.length > 0) {
      return {
        id: 'N3',
        pass: true,
        detail: `checked ${declared.length} declared unmapped column(s) [${declared.join(', ')}] against /schema and ${rowsSeen} search row(s): none exposed`,
      };
    }
    return {
      id: 'N3',
      pass: true,
      detail: `no out-of-band unmapped-column list provided (--unmapped-column); ran the structural check only — ${rowsSeen} search row(s), every field key canonical or present in /schema`,
    };
  },
};
