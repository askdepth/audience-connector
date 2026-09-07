// N8 — a connector FAILS conformance if it "exposes any write path"
// (docs/conformance-spec.md, negative item 8).
//
// Normal polarity: a correct connector PASSES. Two checks:
//
//   1. A battery of write-shaped methods (POST/PUT/DELETE/PATCH) against every
//      known and several guessed paths. A correct connector routes only
//      `GET /health`, `GET /schema`, `POST /candidates/count`,
//      `POST /candidates/search`; everything else is 404/405, and the two POST
//      read endpoints reject the write-shaped body as 400. A 2xx OR 3xx on any
//      combination means a write path answered → FAIL, naming method + path.
//
//   2. The criteria DSL must not be turnable into a write: a value shaped like
//      `'; DROP TABLE candidates; --` sent through the ordinary search body
//      must come back as a normal (here: empty) result, not an error and not a
//      side effect — and an unfiltered count must still be > 0 afterwards.
//
// Only what is reachable over the wire is exercised; there is no out-of-band
// SQL.

import type { ConformanceCase } from '../../runner';
import type { WireResponse } from '../../client';

const WRITE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'] as const;

const PATHS = [
  '/candidates/search', // known read endpoint (POST) — must reject a write body
  '/candidates/count', // known read endpoint (POST) — must reject a write body
  '/candidates', // guessed collection
  '/candidates/1', // guessed item
  '/admin', // guessed
  '/write', // guessed
];

const WRITE_PROBE_BODY = { name: 'conformance-n8-probe', value: 1 };
const INJECTION_VALUE = "'; DROP TABLE candidates; --";

/** A write-shaped method "answered" if it came back 2xx or 3xx. */
function answered(res: WireResponse): boolean {
  return res.status >= 200 && res.status < 400;
}

export const writePathExposedCase: ConformanceCase = {
  id: 'N8',
  kind: 'negative',
  async run(client) {
    for (const method of WRITE_METHODS) {
      for (const path of PATHS) {
        // DELETE carries no body; the rest send a write-shaped payload.
        const body = method === 'DELETE' ? undefined : WRITE_PROBE_BODY;
        const res = await client.request(method, path, body);
        if (answered(res)) {
          return {
            id: 'N8',
            pass: false,
            detail: `write-shaped ${method} ${path} was accepted (HTTP ${res.status}) — a connector must expose no write path; expected a non-2xx/3xx status (401/404/405). Body: "${res.bodyText.slice(0, 160)}"`,
          };
        }
      }
    }

    // The DSL cannot be turned into a write.
    const injectRes = await client.post('/candidates/search', {
      criteria: { all: [{ field: 'segment', op: 'in', values: [INJECTION_VALUE] }] },
      mapping: { src_external_id: 'externalId', src_email: 'email' },
      limit: 10,
    });
    if (injectRes.status !== 200) {
      return {
        id: 'N8',
        pass: false,
        detail: `a SQL-shaped criteria value must be treated as an ordinary (non-matching) filter value, but POST /candidates/search returned HTTP ${injectRes.status}: "${injectRes.bodyText.slice(0, 160)}"`,
      };
    }
    let rows: unknown;
    try {
      rows = (injectRes.json() as { rows?: unknown }).rows;
    } catch {
      rows = undefined;
    }
    if (!Array.isArray(rows)) {
      return {
        id: 'N8',
        pass: false,
        detail: `expected a normal rows[] result for a SQL-shaped criteria value, observed "${injectRes.bodyText.slice(0, 160)}"`,
      };
    }

    // ...and the data set is still there.
    const after = await client.post('/candidates/count', { criteria: { all: [] }, mapping: {} });
    let count: unknown;
    try {
      count = after.status === 200 ? (after.json() as { count?: unknown }).count : undefined;
    } catch {
      count = undefined;
    }
    if (typeof count !== 'number' || count <= 0) {
      return {
        id: 'N8',
        pass: false,
        detail: `after sending a "DROP TABLE"-shaped criteria value, an unfiltered count should still be > 0 (data intact); observed ${JSON.stringify(count)} (HTTP ${after.status})`,
      };
    }

    return { id: 'N8', pass: true };
  },
};
