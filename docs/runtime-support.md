# Runtime support

`@askdepth/audience-connector` core is a Web-standard `Request → Response`
function with no Node built-ins of its own. The one native dependency is in
`@askdepth/audience-contract`'s signing helper, which imports `node:crypto`
(`createHmac`, `timingSafeEqual`). That module is **frozen** at contract v1, so
where a runtime needs help to provide `node:crypto`, the answer is a
configuration flag, not a code change.

Every row below is either **verified** (with how) or **not supported** (with
why). Nothing here is listed on optimism.

| Runtime | Status | How verified / why not |
|---|---|---|
| **Node.js ≥ 22** | ✅ verified | The full `packages/connector` test suite and `examples/smoke.mjs` run on Node in CI (`workspace` job). |
| **Next.js route handler** (Node runtime) | ✅ verified | `packages/connector/__tests__/runtime.test.ts` imports `examples/nextjs-route/app/askdepth/[[...route]]/route.ts`'s `GET`/`POST` exports and drives a signed request end to end. The file contains no adaptation code. |
| **Google Cloud Functions gen2** (Functions Framework) | ✅ verified | `runtime.test.ts` invokes `examples/cloud-function-gen2/index.ts`'s `audienceConnector` export through the Express request/response shape the Functions Framework uses, with a signed request. |
| **Deno** | ✅ verified | CI `runtimes` job runs `deno run --allow-read examples/smoke.mjs`. Deno provides `node:crypto` and Web Crypto natively; no flag needed. |
| **Bun** | ✅ verified | CI `runtimes` job runs `bun examples/smoke.mjs`. Bun provides `node:crypto` natively. |
| **Cloudflare Workers** | ✅ verified *with `nodejs_compat`* | CI `workers` job boots `examples/worker/index.js` under `workerd` via `wrangler unstable_dev` and drives a signed request. **`compatibility_flags = ["nodejs_compat"]` is required** (`examples/worker/wrangler.toml`) — without it, `node:crypto` in the contract's `signing.ts` fails at module load and every request errors. This is a real constraint of the frozen contract, documented rather than worked around. |

## The `node:crypto` finding (Cloudflare Workers)

P1's `signing.ts` is part of the frozen wire contract and uses
`node:crypto`. Cloudflare Workers only exposes `node:crypto` when the
`nodejs_compat` (or `nodejs_compat_v2`) compatibility flag is enabled, which
has been generally available since 2024. Consequences:

- A client deploying to Workers **must** set the flag. The example
  `wrangler.toml` shows it; the client-facing deployment guide repeats it.
- We do **not** ship a Web-Crypto reimplementation of the signer to avoid the
  flag: that would fork the signing logic away from the frozen contract,
  which is precisely the drift the one-way-door rule forbids. If avoiding the
  flag ever becomes a requirement, it is a **contract release**, not a
  connector change.

## Not attempted

- Edge runtimes other than Workers (Vercel Edge, Netlify Edge, Deno Deploy):
  they share Workers' constraints (Web-standard globals, `node:` shims behind
  a flag). Treat them as "Workers with `nodejs_compat`" until a client needs
  one verified.
