// Boots the worker under workerd via wrangler's `unstable_dev` and drives one
// signed request. Run from the repo root:  node examples/worker/smoke.mjs
// (requires `wrangler` on PATH / npx; used by the CI `workers` job).

import { unstable_dev } from 'wrangler';
import { sign, CONTRACT_VERSION } from '../../packages/contract/dist/index.js';

const SECRET = 'worker-smoke-secret';

const worker = await unstable_dev('examples/worker/index.js', {
  config: 'examples/worker/wrangler.toml',
  experimental: { disableExperimentalWarning: true },
});

function headersFor(method, bodyStr) {
  const ts = Math.floor(Date.now() / 1000);
  const signedBody = method === 'GET' ? '' : bodyStr;
  const h = {
    'x-askdepth-signature': sign(signedBody, ts, Buffer.from(SECRET, 'utf8')),
    'x-askdepth-timestamp': String(ts),
  };
  if (method !== 'GET') h['content-type'] = 'application/json';
  return h;
}

let failed = false;
const check = (cond, msg) => {
  if (!cond) {
    console.error(`WORKER SMOKE FAIL: ${msg}`);
    failed = true;
  }
};

try {
  const health = await worker.fetch('http://x/askdepth/v1/health', { headers: headersFor('GET') });
  check(health.status === 200, `/health ${health.status}`);
  const body = await health.json();
  check(body.ok === true && body.contractVersion === CONTRACT_VERSION, '/health body');

  const unsigned = await worker.fetch('http://x/askdepth/v1/health');
  check(unsigned.status === 401, `unsigned ${unsigned.status}`);
} finally {
  await worker.stop();
}

if (failed) process.exit(1);
console.log(`WORKER SMOKE OK (workerd + nodejs_compat, contract ${CONTRACT_VERSION})`);
