// N7 — a connector FAILS conformance if it "returns a non-random subsample
// when `randomSample` is advertised" (docs/conformance-spec.md, negative
// item 6 of the fail list).
//
// Normal polarity: a correct connector PASSES. Only graded when the connector
// advertises `randomSample` in GET /health; otherwise the case is not
// applicable and passes with a note.
//
// Method — the same statistical test the in-memory adapter proves internally
// (plan.test.ts S5.13): with `sample: { method: 'random', size: S }` set,
// draw S rows several times, then over a monotonic ordering field (`signupAt`)
// check that
//
//   * the draw is NOT the first-S rows by insertion order (the oldest S by
//     signup), and
//   * the mean percentile of the drawn `signupAt` values, taken over the whole
//     population, sits near 0.5 — i.e. the draw is spread across the timeline,
//     not clustered at one end.
//
// A connector that answers a sample request with `ORDER BY id LIMIT S`, or the
// oldest S rows, lands near percentile 0 and is flagged.
//
// NOTE: against a *live* connector this case is inherently statistical — a
// genuine random sample will occasionally drift outside the band. A real run
// that fails only N7 should be re-tried a couple of times before the connector
// is judged non-conformant. The CLI's own test suite pins the connector's
// per-pull seed so CI is deterministic.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient } from '../../client';

const MAPPING = { src_external_id: 'externalId', src_email: 'email', src_signup: 'signupAt' };

const DISCOVERY_LIMIT = 500;
const MAX_PAGES = 500;
const SAMPLE_SIZE = 400;
const DRAWS = 5;
// Mean percentile of a uniform sample is 0.5; this half-width tolerates
// sampling noise at S=400 x 5 draws while still catching an insertion-order
// or oldest-first "sample".
const BAND = 0.15;

function fail(detail: string) {
  return { id: 'N7', pass: false, detail } as const;
}

interface PopRow {
  id: string;
  ts: string;
}

async function discoverPopulation(
  client: ConformanceClient,
): Promise<{ ok: true; rows: PopRow[] } | { ok: false; detail: string }> {
  const rows: PopRow[] = [];
  let cursor: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const body: Record<string, unknown> = {
      criteria: { all: [] },
      mapping: MAPPING,
      limit: DISCOVERY_LIMIT,
    };
    if (cursor !== undefined) body.cursor = cursor;
    const res = await client.post('/candidates/search', body);
    if (res.status !== 200) {
      return { ok: false, detail: `population scan: HTTP ${res.status}: "${res.bodyText.slice(0, 160)}"` };
    }
    let parsed: unknown;
    try {
      parsed = res.json();
    } catch {
      return { ok: false, detail: `population scan: body is not JSON: "${res.bodyText.slice(0, 160)}"` };
    }
    const pageRows = (parsed as { rows?: unknown }).rows;
    if (!Array.isArray(pageRows)) {
      return { ok: false, detail: `population scan: no rows[]: "${JSON.stringify(parsed).slice(0, 160)}"` };
    }
    for (const [idx, r] of pageRows.entries()) {
      const id = (r as { externalId?: unknown }).externalId;
      const ts = (r as { signupAt?: unknown }).signupAt;
      if (typeof id !== 'string') {
        return { ok: false, detail: `population scan: row ${idx} has no string externalId` };
      }
      if (typeof ts !== 'string') {
        return {
          ok: false,
          detail: `population scan: row "${id}" has no string signupAt — cannot test sample distribution (map signupAt for display)`,
        };
      }
      rows.push({ id, ts });
    }
    const nextCursor = (parsed as { nextCursor?: unknown }).nextCursor;
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) return { ok: true, rows };
    cursor = nextCursor;
  }
  return { ok: false, detail: `population scan did not terminate within ${MAX_PAGES} pages` };
}

async function drawSample(
  client: ConformanceClient,
  size: number,
): Promise<{ ok: true; rows: PopRow[] } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', {
    criteria: { all: [] },
    mapping: MAPPING,
    limit: size,
    sample: { method: 'random', size },
  });
  if (res.status !== 200) {
    return { ok: false, detail: `sample draw (size ${size}): HTTP ${res.status}: "${res.bodyText.slice(0, 160)}"` };
  }
  let parsed: unknown;
  try {
    parsed = res.json();
  } catch {
    return { ok: false, detail: `sample draw: body is not JSON: "${res.bodyText.slice(0, 160)}"` };
  }
  const pageRows = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(pageRows) || pageRows.length === 0) {
    return { ok: false, detail: `sample draw: no rows[] returned: "${JSON.stringify(parsed).slice(0, 160)}"` };
  }
  const out: PopRow[] = [];
  for (const r of pageRows) {
    const id = (r as { externalId?: unknown }).externalId;
    const ts = (r as { signupAt?: unknown }).signupAt;
    if (typeof id !== 'string' || typeof ts !== 'string') {
      return { ok: false, detail: `sample draw: a row is missing externalId/signupAt: ${JSON.stringify(r).slice(0, 120)}` };
    }
    out.push({ id, ts });
  }
  return { ok: true, rows: out };
}

export const sampleNotRandomCase: ConformanceCase = {
  id: 'N7',
  kind: 'negative',
  async run(client) {
    // Applicability: only graded when randomSample is advertised.
    const health = await client.get('/health');
    let advertises = false;
    try {
      const caps = (health.json() as { capabilities?: unknown }).capabilities;
      advertises = Array.isArray(caps) && caps.includes('randomSample');
    } catch {
      advertises = false;
    }
    if (!advertises) {
      return {
        id: 'N7',
        pass: true,
        detail: 'connector does not advertise `randomSample` in /health — case not applicable',
      };
    }

    const pop = await discoverPopulation(client);
    if (!pop.ok) return fail(pop.detail);
    const popN = pop.rows.length;
    if (popN < 4) {
      return {
        id: 'N7',
        pass: true,
        detail: `precondition: need >= 4 candidates to test sample distribution, observed ${popN}`,
      };
    }

    const size = Math.min(SAMPLE_SIZE, Math.max(2, Math.floor(popN / 2)));

    // Sorted timeline + the oldest-`size` id set (== first-S by insertion order,
    // signupAt being monotonic with insertion).
    const sortedTs = pop.rows.map((r) => r.ts).sort();
    const oldestIds = new Set(
      [...pop.rows].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)).slice(0, size).map((r) => r.id),
    );
    const percentileOf = (ts: string): number => {
      // fraction of the population strictly older than `ts`
      let lo = 0;
      let hi = sortedTs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTs[mid] < ts) lo = mid + 1;
        else hi = mid;
      }
      return lo / (sortedTs.length - 1);
    };

    const drawMeans: number[] = [];
    for (let d = 0; d < DRAWS; d++) {
      const draw = await drawSample(client, size);
      if (!draw.ok) return fail(draw.detail);

      const drawIds = new Set(draw.rows.map((r) => r.id));
      const sameAsOldest =
        drawIds.size === oldestIds.size && [...drawIds].every((id) => oldestIds.has(id));
      if (sameAsOldest) {
        return fail(
          `sample draw ${d + 1} of ${DRAWS} returned exactly the ${size} oldest rows by signup order (the first-${size} by insertion order) — that is not a random subsample`,
        );
      }

      const mean = draw.rows.reduce((a, r) => a + percentileOf(r.ts), 0) / draw.rows.length;
      drawMeans.push(mean);
    }

    const meanOfMeans = drawMeans.reduce((a, b) => a + b, 0) / drawMeans.length;
    const per = drawMeans.map((m) => m.toFixed(3)).join(', ');
    if (meanOfMeans < 0.5 - BAND || meanOfMeans > 0.5 + BAND) {
      return fail(
        `mean signupAt percentile of the sampled rows is ${meanOfMeans.toFixed(3)} ` +
          `(per-draw: ${per}), outside the band [${(0.5 - BAND).toFixed(2)}, ${(0.5 + BAND).toFixed(2)}] ` +
          `— the "random" sample is biased toward one end of the timeline`,
      );
    }

    return {
      id: 'N7',
      pass: true,
      detail: `${DRAWS} draws of ${size} from ${popN}: mean signupAt percentile ${meanOfMeans.toFixed(3)} ` +
        `within band [${(0.5 - BAND).toFixed(2)}, ${(0.5 + BAND).toFixed(2)}]; no draw equalled the oldest ${size}`,
    };
  },
};
