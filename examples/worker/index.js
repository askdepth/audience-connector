// Cloudflare Workers entry.
//
// The connector is a Web-standard `Request → Response` function, so a Worker's
// `fetch` handler forwards straight to it — no adaptation code.
//
// REQUIRES the `nodejs_compat` compatibility flag (see wrangler.toml):
// `@askdepth/audience-contract`'s signing helper imports `node:crypto`
// (`createHmac`, `timingSafeEqual`). Without the flag those imports fail at
// module load and every request errors. `signing.ts` is frozen (contract v1),
// so the flag — not a code change — is the answer. See docs/runtime-support.md.

import { createConnector, restAdapter } from '../../packages/connector/dist/index.js';

const connector = createConnector({
  secret: 'worker-smoke-secret',
  fieldMapping: { externalId: 'id', email: 'email' },
  adapter: restAdapter({
    declaredSchema: { columns: [{ name: 'id', type: 'string' }] },
    fetchCandidates: async () => [],
    fetchCount: async () => 7,
  }),
});

export default {
  fetch(request) {
    return connector.fetch(request);
  },
};
