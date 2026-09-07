// N3 — a connector FAILS conformance if it "returns unmapped columns"
// (docs/conformance-spec.md, negative item 3).
//
// Normal polarity: a correct connector PASSES. A canonical result row is a
// closed shape (master §4.3): a connector maps its store columns to the
// canonical fields and returns nothing else. A row carrying a key that is
// neither a canonical field nor something the connector itself declares in
// `/schema` is an unmapped column that leaked — most often a raw `SELECT *`.
//
// Spec item 3 ("returns unmapped columns") is about **candidate-data
// leakage**, not schema introspection. A genuine postgres connector's
// `/schema` legitimately lists every introspected store column — including
// ones that are not in `fieldMapping` (P2, `postgres.test.ts` S6.16). So this
// case grades **only** the candidate-data responses: `/candidates/search` row
// payloads and `/candidates/count` bodies. A declared-unmapped name appearing
// in `/schema` `columns` is NOT a failure.
//
// Two modes:
//
//   * **Structural (always).** Every key of every `/candidates/search` row must
//     be a canonical field, or — for a connector whose row keys mirror its
//     store column names — present in the connector's own `/schema` `columns`.
//     Anything else is flagged, naming the key. The same check descends into
//     `row.attributes`: a key there that collides with a `/schema` column name
//     (a raw store column dumped under `attributes`) or was named via
//     `--unmapped-column` is flagged too; a nested key that is neither is
//     taken to be a legitimately-mapped display attribute. This is the weaker
//     check: a connector that over-returns a store column it *also* lists in
//     `/schema` slips through, which is why the out-of-band list exists.
//
//   * **Declared (when `--unmapped-column <name>` was given).** The operator
//     has named store columns that exist in the backing data but are
//     intentionally unmapped and sensitive; they must appear in no
//     **candidate-data** response. The case asserts each declared name is
//     absent from every `/candidates/search` response body and every
//     `/candidates/count` body (raw text — catches a nested or renamed leak
//     too). `/schema` is deliberately not graded here.
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
//
// `MINIMAL_MAPPING` is the mandatory probe: `externalId` + `email` are the only
// two canonical fields every conformant connector must map. `DISPLAY_MAPPING`
// projects optional fields (`segment`, `signupAt`) — a conformant connector is
// free NOT to map them and to answer `malformed_request` (HTTP 400) for that
// projection target (`CanonicalFieldSchema` marks them `.optional()`). So the
// display probe is *tolerant*: a 400 skips it rather than failing N3. `name` is
// deliberately absent — the reference connector does not map it.
const MINIMAL_MAPPING = { src_external_id: 'externalId', src_email: 'email' };
const DISPLAY_MAPPING = {
  src_external_id: 'externalId',
  src_email: 'email',
  src_segment: 'segment',
  src_signup: 'signupAt',
};

/** A tolerant probe returns this instead of a value when the connector answers
 *  HTTP 400 for an optional-field projection it does not support. */
const SKIPPED = Symbol('probe-skipped-optional-projection');

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

/** True when the connector rejected a request as malformed — the expected
 *  answer when a mapping projects an optional canonical field it does not map. */
function isMalformedRejection(res: WireResponse): boolean {
  if (res.status !== 400) return false;
  try {
    return (res.json() as { error?: { code?: unknown } }).error?.code === 'malformed_request';
  } catch {
    return false;
  }
}

async function searchProbe(
  client: ConformanceClient,
  label: string,
  mapping: Record<string, string>,
  tolerant = false,
): Promise<{ ok: true; probe: SearchProbe | typeof SKIPPED } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', {
    criteria: { all: [] },
    mapping,
    limit: 100,
  });
  if (res.status !== 200) {
    if (tolerant && isMalformedRejection(res)) return { ok: true, probe: SKIPPED };
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

async function countProbe(
  client: ConformanceClient,
  label: string,
  mapping: Record<string, string>,
  tolerant = false,
): Promise<{ ok: true; res: WireResponse | typeof SKIPPED } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/count', { criteria: { all: [] }, mapping });
  if (res.status !== 200) {
    if (tolerant && isMalformedRejection(res)) return { ok: true, res: SKIPPED };
    return { ok: false, detail: `${label}: expected HTTP 200, observed ${res.status}: "${res.bodyText.slice(0, 160)}"` };
  }
  return { ok: true, res };
}

/**
 * A key that appears BOTH under `row.attributes` AND in `/schema` `columns` is
 * ambiguous: it could be a raw store column dumped by `SELECT *`, or a
 * legitimately-mapped display attribute whose name merely coincides with a
 * declared column (the reference connector's hand-declared REST schema lists
 * its attribute-backing columns). The wire exposes no "returnable attributes"
 * list, but a returnable display attribute must also be **filterable** (the
 * handler enforces `returnable ⊆ filterable`). So probe with an `attr.<key>`
 * filter: if the connector accepts it, `<key>` is a declared attribute — not a
 * leak; if it rejects it as `malformed_request`, `<key>` is not filterable and
 * its presence under `attributes` is an unmapped store column that leaked.
 * `{ decided: false }` when the answer is inconclusive (e.g. the connector
 * advertises no attribute filtering at all) — the case then does not flag it.
 */
async function isDeclaredFilterableAttr(
  client: ConformanceClient,
  key: string,
  sampleValue: unknown,
): Promise<{ decided: true; legit: boolean } | { decided: false }> {
  const value =
    typeof sampleValue === 'string' ||
    typeof sampleValue === 'number' ||
    typeof sampleValue === 'boolean'
      ? sampleValue
      : '__conformance_probe__';
  const res = await client.post('/candidates/count', {
    criteria: { all: [{ field: `attr.${key}`, op: 'eq', value }] },
    mapping: {},
  });
  if (res.status === 200) return { decided: true, legit: true };
  if (isMalformedRejection(res)) return { decided: true, legit: false };
  return { decided: false };
}

export const unmappedColumnsLeakedCase: ConformanceCase = {
  id: 'N3',
  kind: 'negative',
  async run(client, context) {
    const declared = [...(context?.unmappedColumns ?? [])];
    // `attr.<key>` acceptance is a per-connector fact — probe each key once.
    const attrProbeCache = new Map<
      string,
      { decided: true; legit: boolean } | { decided: false }
    >();

    // `/schema` is fetched only to seed the structural row-key check below.
    // A declared-unmapped name appearing in `/schema` `columns` is legitimate
    // (a postgres connector introspects the whole store) and is NOT graded —
    // spec item 3 is about candidate-data leakage.
    const schema = await schemaColumnNames(client);
    if (!schema.ok) return fail(schema.detail);
    const schemaCols = schema.names;

    const probes: SearchProbe[] = [];
    for (const [label, mapping, tolerant] of [
      ['POST /candidates/search (identity mapping)', MINIMAL_MAPPING, false],
      ['POST /candidates/search (display mapping)', DISPLAY_MAPPING, true],
    ] as const) {
      const p = await searchProbe(client, label, mapping, tolerant);
      if (!p.ok) return fail(p.detail);
      if (p.probe === SKIPPED) continue; // connector does not map these optional fields
      probes.push(p.probe);
    }

    // 1. Declared sensitive columns must not appear in a `/candidates/count`
    //    body either (a careless connector might echo the plan / mapping).
    let countsSeen = 0;
    if (declared.length > 0) {
      for (const [label, mapping, tolerant] of [
        ['POST /candidates/count (identity mapping)', MINIMAL_MAPPING, false],
        ['POST /candidates/count (display mapping)', DISPLAY_MAPPING, true],
      ] as const) {
        const c = await countProbe(client, label, mapping, tolerant);
        if (!c.ok) return fail(c.detail);
        if (c.res === SKIPPED) continue;
        countsSeen++;
        for (const col of declared) {
          if (c.res.bodyText.includes(col)) {
            return fail(
              `${label}: response body contains the declared unmapped column "${col}" — a count response must carry nothing but the integer`,
            );
          }
        }
      }
    }

    let rowsSeen = 0;
    for (const { label, res, rows } of probes) {
      rowsSeen += rows.length;

      // 2. Declared sensitive columns must not appear anywhere in a
      //    candidate-data (search) body.
      for (const col of declared) {
        if (res.bodyText.includes(col)) {
          return fail(
            `${label}: response body contains the declared unmapped column "${col}" — a mapped, capped projection must never expose it`,
          );
        }
      }

      // 3. Structural: no foreign top-level key on any row, and no raw store
      //    column dumped INSIDE `row.attributes`.
      for (const [idx, row] of rows.entries()) {
        if (typeof row !== 'object' || row === null) {
          return fail(`${label}: row ${idx} is not an object: ${JSON.stringify(row).slice(0, 120)}`);
        }

        // 3a. Descend into `row.attributes`. A connector that answers
        //     `SELECT *` under `attributes: { ssn: …, internal_notes: … }`
        //     would not be caught by the top-level key check. A nested key is
        //     flagged when it was named via `--unmapped-column`, or when it
        //     collides with a `/schema` column name AND the connector does not
        //     accept it as an `attr.*` filter (see
        //     {@link isDeclaredFilterableAttr}). A nested key that is neither is
        //     taken to be a legitimately-mapped display attribute — structurally
        //     we cannot prove otherwise, and the declared-list `bodyText`
        //     backstop above still catches a renamed leak.
        const attrs = (row as { attributes?: unknown }).attributes;
        if (attrs !== null && typeof attrs === 'object' && !Array.isArray(attrs)) {
          for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
            if (declared.includes(key)) {
              return fail(
                `${label}: row ${idx} ("${String(row.externalId)}") nests the declared unmapped column "${key}" inside row.attributes — a mapped, capped projection must never expose it`,
              );
            }
            if (!schemaCols.has(key)) continue; // presumed a mapped display attribute
            let verdict = attrProbeCache.get(key);
            if (verdict === undefined) {
              verdict = await isDeclaredFilterableAttr(client, key, value);
              attrProbeCache.set(key, verdict);
            }
            if (verdict.decided && !verdict.legit) {
              return fail(
                `${label}: row ${idx} ("${String(row.externalId)}") nests "${key}" inside row.attributes — a /schema store column the connector does not expose as a filterable attribute, i.e. an unmapped column leaked (SELECT * under attributes?)`,
              );
            }
          }
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
        detail: `checked ${declared.length} declared unmapped column(s) [${declared.join(', ')}] against ${countsSeen} count body/bodies and ${rowsSeen} search row(s): none exposed (/schema not graded)`,
      };
    }
    return {
      id: 'N3',
      pass: true,
      detail: `no out-of-band unmapped-column list provided (--unmapped-column); ran the structural check only — ${rowsSeen} search row(s), every field key canonical or present in /schema`,
    };
  },
};
