// N4 — a connector FAILS conformance if it "leaks credentials or row data in
// an error response" (docs/conformance-spec.md, negative item 4).
//
// Normal polarity: a correct connector PASSES. The connector's error bodies
// are meant to be fixed, input-free strings (`{ "error": { code, message } }`
// with a message from a constant table). This case feeds inputs engineered to
// surface in a careless error message, then scans the FULL response body of
// every input-taking endpoint for them.
//
// The credential-shaped regexes below are DELIBERATELY re-declared here and
// NOT imported from `src/errors.ts` (`redact()`): the case must detect a leak
// independently of the code it is grading.
//
// Every probe is crafted to match NO row in a normal data set (an impossible
// `segment`, an impossible `attr.plan`), so a correct connector's bodies are
// `{"count":0}` / `{"rows":[]}` / a fixed 400 — nothing for the scan to hit.

import type { ConformanceCase } from '../../runner';
import type { ConformanceClient, WireResponse } from '../../client';

// Unique, unmistakable markers planted in the request. If either appears in a
// response body, the connector round-tripped our input into its output.
const TRACER_TOKEN = 'zzTRACERzz';
const FAKE_DSN = 'postgres://user:pw@host:5432/db';

// Credential-shaped patterns, matched independently of the planted markers.
// Own copies — see the header note. Kept deliberately broad.
const CREDENTIAL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    name: 'connection-string URI (scheme://user:pass@host)',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]+@[^\s/'"]+/i,
  },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/ },
  { name: 'password= / password: value', re: /\bpass(?:word|wd)?\s*["']?\s*[:=]\s*["']?[^\s,;"'}]+/i },
  { name: 'PEM private-key header', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { name: 'long hex secret (>= 32)', re: /\b[0-9a-f]{32,}\b/i },
  { name: 'long base64 secret (>= 40)', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/ },
];

const MAPPING = { src_external_id: 'externalId', src_email: 'email' };

function snippetAround(haystack: string, needle: string): string {
  const i = haystack.indexOf(needle);
  const from = Math.max(0, i - 40);
  const to = Math.min(haystack.length, i + needle.length + 40);
  return `${from > 0 ? '…' : ''}${haystack.slice(from, to)}${to < haystack.length ? '…' : ''}`;
}

async function gather(client: ConformanceClient): Promise<Array<{ label: string; res: WireResponse }>> {
  const probes: Array<{ label: string; res: WireResponse }> = [];

  // 1. tracer + fake DSN as ordinary filter values that reach the adapter.
  const seg = { all: [{ field: 'segment', op: 'in', values: [TRACER_TOKEN, FAKE_DSN] }] };
  probes.push({
    label: 'POST /candidates/count  (segment IN [tracer, dsn])',
    res: await client.post('/candidates/count', { criteria: seg, mapping: MAPPING }),
  });
  probes.push({
    label: 'POST /candidates/search (segment IN [tracer, dsn])',
    res: await client.post('/candidates/search', { criteria: seg, mapping: MAPPING, limit: 100 }),
  });

  // 2. fake DSN as an attribute-filter value (also reaches the adapter).
  const attrVal = { all: [{ field: 'attr.plan', op: 'eq', value: FAKE_DSN }] };
  probes.push({
    label: 'POST /candidates/count  (attr.plan == dsn)',
    res: await client.post('/candidates/count', { criteria: attrVal, mapping: MAPPING }),
  });

  // 3. tracer as an attribute NAME — rejected in validation. A connector that
  //    echoes its validation errors would surface "zzTRACERzz" here.
  const attrName = { all: [{ field: `attr.${TRACER_TOKEN}`, op: 'eq', value: TRACER_TOKEN }] };
  probes.push({
    label: 'POST /candidates/count  (attr.<tracer>)',
    res: await client.post('/candidates/count', { criteria: attrName, mapping: MAPPING }),
  });

  // 4. tracer in the request mapping keys, on an empty (non-matching) query.
  probes.push({
    label: 'POST /candidates/search (tracer in mapping keys)',
    res: await client.post('/candidates/search', {
      criteria: { all: [{ field: 'segment', op: 'in', values: [TRACER_TOKEN] }] },
      mapping: { [TRACER_TOKEN]: 'externalId', src_email: 'email' },
      limit: 1000,
    }),
  });

  return probes;
}

export const errorLeaksDataCase: ConformanceCase = {
  id: 'N4',
  kind: 'negative',
  async run(client) {
    for (const { label, res } of await gather(client)) {
      const body = res.bodyText;

      for (const marker of [TRACER_TOKEN, FAKE_DSN]) {
        if (body.includes(marker)) {
          return {
            id: 'N4',
            pass: false,
            detail: `${label} → HTTP ${res.status}: response body echoed the planted input "${marker}" — "${snippetAround(body, marker)}"`,
          };
        }
      }

      for (const { name, re } of CREDENTIAL_PATTERNS) {
        const m = re.exec(body);
        if (m) {
          return {
            id: 'N4',
            pass: false,
            detail: `${label} → HTTP ${res.status}: response body contains a ${name}: "${m[0].slice(0, 100)}"`,
          };
        }
      }
    }
    return { id: 'N4', pass: true };
  },
};
