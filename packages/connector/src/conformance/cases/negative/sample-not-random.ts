// N7 — a connector FAILS conformance if it "returns a non-random subsample
// when `randomSample` is advertised" (docs/conformance-spec.md, negative
// item 6 of the fail list).
//
// Normal polarity: a correct connector PASSES. Only graded when the connector
// advertises `randomSample` in GET /health; otherwise the case is not
// applicable and passes with a note.
//
// Method — the same statistical test the in-memory adapter proves internally
// (plan.test.ts S5.13). With `sample: { method: 'random', size: S }` set, draw
// S rows several times, then over a fixed reference ordering of the population
// check that
//
//   * no draw is exactly the first-S of that ordering (the "oldest S");
//   * the mean position-percentile of the drawn rows sits near 0.5 — the draw
//     is spread across the ordering, not clustered at one end;
//   * consecutive draws actually DIFFER — mean pairwise Jaccard similarity of
//     the drawn id sets is not suspiciously high, and no two draws are
//     byte-identical id sets. A connector returning a fixed pseudo-random
//     subset on every pull (e.g. a hard-coded shuffle seed) lands near J = 1.
//
// The reference ordering is `signupAt` (ascending) when the connector maps that
// optional canonical field; `signupAt` is `.optional()` in `CanonicalFieldSchema`,
// so a spec-conformant `randomSample` connector may not map it — in that case
// N7 falls back to the population's insertion order, learned as the lexically
// sorted `externalId` list from a plain paginated scan (the synthetic bases use
// zero-padded sequential ids, so lexical order == insertion order). `detail`
// states which mode ran.
//
// NOTE: against a *live* connector this case is inherently statistical — a
// genuine random sample will occasionally drift outside the band. A real run
// that fails only N7 should be re-tried a couple of times before the connector
// is judged non-conformant. The CLI's own test suite pins the connector's
// per-pull seed so CI is deterministic.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient, WireResponse } from '../../client';

const IDENTITY_MAPPING = { src_external_id: 'externalId', src_email: 'email' };
const SIGNUP_MAPPING = { ...IDENTITY_MAPPING, src_signup: 'signupAt' };

const DISCOVERY_LIMIT = 500;
const MAX_PAGES = 500;
const SAMPLE_SIZE = 400;
const DRAWS = 5;
// Mean position-percentile of a uniform sample is 0.5; this half-width
// tolerates sampling noise at S=400 x 5 draws while still catching an
// insertion-order or oldest-first "sample".
const BAND = 0.15;

type Mode = 'signupAt' | 'insertion-order';

function fail(detail: string) {
  return { id: 'N7', pass: false, detail } as const;
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

interface ScanRow {
  id: string;
  ts?: string;
}

/** Paginate the whole population with `mapping`. In `signupAt` mode every row
 *  must carry a string `signupAt`; in `insertion-order` mode only `externalId`
 *  is required. */
async function scanPopulation(
  client: ConformanceClient,
  mapping: Record<string, string>,
  mode: Mode,
): Promise<{ ok: true; rows: ScanRow[] } | { ok: false; detail: string }> {
  const rows: ScanRow[] = [];
  let cursor: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const body: Record<string, unknown> = { criteria: { all: [] }, mapping, limit: DISCOVERY_LIMIT };
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
      if (typeof id !== 'string') {
        return { ok: false, detail: `population scan: row ${idx} has no string externalId` };
      }
      if (mode === 'signupAt') {
        const ts = (r as { signupAt?: unknown }).signupAt;
        if (typeof ts !== 'string') {
          return {
            ok: false,
            detail: `population scan: row "${id}" has no string signupAt — cannot test sample distribution`,
          };
        }
        rows.push({ id, ts });
      } else {
        rows.push({ id });
      }
    }
    const nextCursor = (parsed as { nextCursor?: unknown }).nextCursor;
    if (typeof nextCursor !== 'string' || nextCursor.length === 0) return { ok: true, rows };
    cursor = nextCursor;
  }
  return { ok: false, detail: `population scan did not terminate within ${MAX_PAGES} pages` };
}

async function drawSample(
  client: ConformanceClient,
  mapping: Record<string, string>,
  mode: Mode,
  size: number,
): Promise<{ ok: true; rows: ScanRow[] } | { ok: false; detail: string }> {
  const res = await client.post('/candidates/search', {
    criteria: { all: [] },
    mapping,
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
  const rows: ScanRow[] = [];
  for (const r of pageRows) {
    const id = (r as { externalId?: unknown }).externalId;
    if (typeof id !== 'string') {
      return { ok: false, detail: `sample draw: a row is missing externalId: ${JSON.stringify(r).slice(0, 120)}` };
    }
    if (mode === 'signupAt') {
      const ts = (r as { signupAt?: unknown }).signupAt;
      if (typeof ts !== 'string') {
        return { ok: false, detail: `sample draw: row "${id}" is missing signupAt` };
      }
      rows.push({ id, ts });
    } else {
      rows.push({ id });
    }
  }
  return { ok: true, rows };
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

    // Mode selection: does the connector map the optional `signupAt` field?
    const probe = await client.post('/candidates/search', {
      criteria: { all: [] },
      mapping: SIGNUP_MAPPING,
      limit: 1,
    });
    let mode: Mode;
    if (probe.status === 200) {
      mode = 'signupAt';
    } else if (isMalformedRejection(probe)) {
      mode = 'insertion-order';
    } else {
      return fail(
        `mode probe: POST /candidates/search with signupAt mapped returned HTTP ${probe.status}: "${probe.bodyText.slice(0, 160)}"`,
      );
    }
    const mapping = mode === 'signupAt' ? SIGNUP_MAPPING : IDENTITY_MAPPING;

    const scan = await scanPopulation(client, mapping, mode);
    if (!scan.ok) return fail(scan.detail);

    // A fixed reference ordering of the population, then a SORTED KEY ARRAY the
    // draws are ranked against by binary search. In `signupAt` mode the key is
    // the timestamp; in the fallback it is the `externalId` itself (lexical
    // order == insertion order for the zero-padded synthetic ids). Ranking by
    // binary search — rather than an exact position lookup — keeps the metric
    // robust when the population scan is itself unreliable (e.g. an N5-style
    // connector whose paginated scan overlaps or drops rows): a sampled id that
    // was never scanned still gets a sensible percentile from where it *would*
    // sort.
    const orderedRows =
      mode === 'signupAt'
        ? [...scan.rows].sort((a, b) => (a.ts! < b.ts! ? -1 : a.ts! > b.ts! ? 1 : a.id < b.id ? -1 : 1))
        : [...scan.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const popN = orderedRows.length;
    if (popN < 4) {
      return {
        id: 'N7',
        pass: true,
        detail: `precondition: need >= 4 candidates to test sample distribution, observed ${popN}`,
      };
    }

    const size = Math.min(SAMPLE_SIZE, Math.max(2, Math.floor(popN / 2)));
    const oldestIds = new Set(orderedRows.slice(0, size).map((r) => r.id));
    const sortedKeys = orderedRows.map((r) => (mode === 'signupAt' ? r.ts! : r.id));
    // fraction of the population that sorts strictly before `key`
    const percentileOf = (key: string): number => {
      let lo = 0;
      let hi = sortedKeys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedKeys[mid] < key) lo = mid + 1;
        else hi = mid;
      }
      return lo / (sortedKeys.length - 1);
    };

    // Expected pairwise Jaccard of two INDEPENDENT uniform size-S draws from a
    // population of N:
    //   E|A ∩ B| ≈ S·(S/N) = S²/N      E|A ∪ B| ≈ 2S − S²/N
    //   E[J]      = (S/N) / (2 − S/N)
    // e.g. S=400,N=900 → ≈0.28; S=400,N=3200 → ≈0.067. A connector that returns
    // the SAME subset on every pull sits at J ≈ 1. Flag when the mean pairwise
    // J over the DRAWS−1 consecutive pairs exceeds 3× the expected value,
    // floored at 0.6 so a large population cannot drive the bar beneath
    // ordinary sampling noise.
    const sByN = size / popN;
    const expectedJaccard = sByN / (2 - sByN);
    const jaccardCeiling = Math.max(0.6, expectedJaccard * 3);

    const drawMeans: number[] = [];
    const idSets: Set<string>[] = [];
    for (let d = 0; d < DRAWS; d++) {
      const draw = await drawSample(client, mapping, mode, size);
      if (!draw.ok) return fail(draw.detail);

      const drawIds = new Set(draw.rows.map((r) => r.id));
      idSets.push(drawIds);

      const sameAsOldest =
        drawIds.size === oldestIds.size && [...drawIds].every((id) => oldestIds.has(id));
      if (sameAsOldest) {
        return fail(
          `sample draw ${d + 1} of ${DRAWS} returned exactly the ${size} first rows of the ${mode} ordering ` +
            `(the "oldest ${size}") — that is not a random subsample`,
        );
      }

      let sum = 0;
      for (const r of draw.rows) {
        sum += percentileOf(mode === 'signupAt' ? r.ts! : r.id);
      }
      drawMeans.push(sum / draw.rows.length);
    }

    // Distribution: the mean position-percentile must sit near 0.5.
    const meanOfMeans = drawMeans.reduce((a, b) => a + b, 0) / drawMeans.length;
    const per = drawMeans.map((m) => m.toFixed(3)).join(', ');
    if (meanOfMeans < 0.5 - BAND || meanOfMeans > 0.5 + BAND) {
      return fail(
        `mean ${mode} position-percentile of the sampled rows is ${meanOfMeans.toFixed(3)} ` +
          `(per-draw: ${per}), outside the band [${(0.5 - BAND).toFixed(2)}, ${(0.5 + BAND).toFixed(2)}] ` +
          `— the "random" sample is biased toward one end of the ordering`,
      );
    }

    // Diversity: consecutive draws must actually differ.
    for (let i = 1; i < idSets.length; i++) {
      const a = idSets[i - 1];
      const b = idSets[i];
      if (a.size === b.size && [...a].every((id) => b.has(id))) {
        return fail(
          `sample draws ${i} and ${i + 1} of ${DRAWS} returned byte-identical id sets — the "random" ` +
            `subsample is a fixed selection, not an independent draw`,
        );
      }
    }
    const jaccards: number[] = [];
    for (let i = 1; i < idSets.length; i++) {
      const a = idSets[i - 1];
      const b = idSets[i];
      let inter = 0;
      for (const id of a) if (b.has(id)) inter++;
      const union = a.size + b.size - inter;
      jaccards.push(union === 0 ? 0 : inter / union);
    }
    const meanJaccard = jaccards.reduce((a, b) => a + b, 0) / jaccards.length;
    if (meanJaccard > jaccardCeiling) {
      return fail(
        `mean pairwise Jaccard similarity between consecutive sample draws is ${meanJaccard.toFixed(3)} ` +
          `(per-pair: ${jaccards.map((j) => j.toFixed(3)).join(', ')}), above the ceiling ${jaccardCeiling.toFixed(3)} ` +
          `(≈3× the ${expectedJaccard.toFixed(3)} expected for independent draws) — the draws barely differ, so the ` +
          `subsample is not re-randomised per pull`,
      );
    }

    return {
      id: 'N7',
      pass: true,
      detail:
        `${mode} mode: ${DRAWS} draws of ${size} from ${popN}: mean position-percentile ${meanOfMeans.toFixed(3)} ` +
        `within band [${(0.5 - BAND).toFixed(2)}, ${(0.5 + BAND).toFixed(2)}]; no draw equalled the first ${size}; ` +
        `mean pairwise Jaccard ${meanJaccard.toFixed(3)} <= ${jaccardCeiling.toFixed(3)}`,
    };
  },
};
