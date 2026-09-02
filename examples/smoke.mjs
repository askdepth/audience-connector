// Runtime-agnostic smoke test. Imports the *built* packages and drives one
// signed request through `connector.fetch`, using only Web-standard APIs plus
// whatever `@askdepth/audience-contract`'s signer needs (`node:crypto`, which
// Node, Deno and Bun all provide).
//
//   node examples/smoke.mjs
//   deno run examples/smoke.mjs
//   bun  examples/smoke.mjs
//
// Exits 0 on success, 1 on failure. No network, no filesystem.

import { createConnector, restAdapter } from '../packages/connector/dist/index.js';
import { sign, CONTRACT_VERSION } from '../packages/contract/dist/index.js';

const SECRET = 'smoke-secret';
const enc = new TextEncoder();

const connector = createConnector({
  secret: SECRET,
  fieldMapping: { externalId: 'id', email: 'email' },
  adapter: restAdapter({
    declaredSchema: { columns: [{ name: 'id', type: 'string' }] },
    fetchCandidates: async () => [],
    fetchCount: async () => 7,
  }),
});

function signedRequest(method, path, bodyStr) {
  const ts = Math.floor(Date.now() / 1000);
  const signedBody = method === 'GET' ? '' : bodyStr;
  const headers = new Headers({
    'x-askdepth-signature': sign(signedBody, ts, toBytes(SECRET)),
    'x-askdepth-timestamp': String(ts),
  });
  if (method !== 'GET') headers.set('content-type', 'application/json');
  return new Request(`https://smoke.test${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : bodyStr,
  });
}

function toBytes(s) {
  // `sign` accepts a Buffer in Node; a Uint8Array works everywhere `node:crypto`
  // is available (Node/Deno/Bun).
  return typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8') : enc.encode(s);
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
}

const runtime =
  typeof Deno !== 'undefined'
    ? `Deno ${Deno.version.deno}`
    : typeof Bun !== 'undefined'
      ? `Bun ${Bun.version}`
      : `Node ${process.version}`;

const health = await connector.fetch(signedRequest('GET', '/askdepth/v1/health'));
assert(health.status === 200, `/health status ${health.status}`);
const healthBody = await health.json();
assert(healthBody.ok === true, '/health ok flag');
assert(healthBody.contractVersion === CONTRACT_VERSION, '/health contractVersion');

const count = await connector.fetch(
  signedRequest('POST', '/askdepth/v1/candidates/count', JSON.stringify({ criteria: { all: [] }, mapping: {} })),
);
assert(count.status === 200, `/count status ${count.status}`);
assert((await count.json()).count === 7, '/count value');

const unsigned = await connector.fetch(
  new Request('https://smoke.test/askdepth/v1/health', { method: 'GET' }),
);
assert(unsigned.status === 401, `unsigned should be 401, got ${unsigned.status}`);

console.log(`SMOKE OK on ${runtime} (contract ${CONTRACT_VERSION})`);
