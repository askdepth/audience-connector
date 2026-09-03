# Deploying `@askdepth/audience-connector`

**We query you.** The Askdepth platform sends your connector a signed criteria
query; your connector runs it inside your own infrastructure, against your own
database, and answers with counts plus a capped, column-mapped, read-only
result set. **Your raw data and your database credentials never leave your
perimeter.**

---

## 1. Install

```bash
pnpm add @askdepth/audience-connector
# postgres adapter only:
pnpm add pg
```

Core has **zero runtime dependencies**. `pg` is an optional peer; the `rest`
adapter needs nothing but a `fetch`-like function you supply.

## 2. Construct the connector

```ts
import { createConnector, postgresAdapter } from '@askdepth/audience-connector';
import { Pool } from 'pg';

export const connector = createConnector({
  // The signing secret Askdepth issued for this connector. Keep it in a
  // secret store, never in source. There is no "skip verification" flag.
  secret: process.env.AUDIENCE_CONNECTOR_SECRET!,

  // canonical field -> YOUR column. This is the whitelist: a canonical field
  // absent here does not exist as far as the connector is concerned. No
  // special-category fields (health, religion, politics, sexual orientation,
  // biometrics) — they are refused at construction.
  fieldMapping: {
    externalId: 'user_id',
    email: 'email',
    segment: 'plan_tier',
    signupAt: 'created_at',
    isActive: 'is_active',
  },

  // Optional: attributes usable in criteria as `attr.*`. Filter-only unless
  // also listed in `returnable`. Max 10 filterable.
  attributes: { filterable: ['region', 'plan'], returnable: ['plan'] },

  adapter: postgresAdapter({
    pool: new Pool({ connectionString: process.env.READONLY_DATABASE_URL }),
    table: 'users',
    schema: 'public',
  }),
});
```

### Recommended: a read-only database role

The adapter is read-only *by construction* — it emits only `SELECT`, wraps
every query in `BEGIN READ ONLY`, and sets `statement_timeout`. Still, give it
a database role with `SELECT`-only grants on the mapped table. We cannot verify
your role from here; defence in depth is yours to add.

## 3. Mount it

The connector is a Web-standard `Request → Response` handler. Framework
integration is a thin shim.

### The raw-body requirement (read this)

The signature is an HMAC over the **exact request bytes**. Any middleware that
parses and re-serialises the JSON body changes those bytes and every signature
fails. Each shim needs the raw bytes.

**Express — the footgun.** `express.json()` has already discarded the raw
body. Mount `express.raw` instead:

```ts
import express from 'express';
import { expressHandler } from '@askdepth/audience-connector/express';

const app = express();
app.use(express.raw({ type: 'application/json' })); // NOT express.json()
app.use(expressHandler(connector));
```

If the shim only sees a parsed body it fails the first request with a message
naming the fix — it never silently rejects everything as unsigned.

### Fastify

```ts
import Fastify from 'fastify';
import { fastifyPlugin } from '@askdepth/audience-connector/fastify';

const app = Fastify();
await app.register(fastifyPlugin(connector)); // installs a raw-buffer parser
```

### AWS Lambda (API Gateway HTTP API v2)

```ts
import { lambdaHandler } from '@askdepth/audience-connector/lambda';
export const handler = lambdaHandler(connector); // honours isBase64Encoded
```

### Next.js route handler / Cloud Functions gen2 / Workers / Deno / Bun

See [`runtime-support.md`](./runtime-support.md) and `examples/`. Cloudflare
Workers requires the `nodejs_compat` compatibility flag (the contract's signer
uses `node:crypto`).

## 4. The four endpoints

Mounted under `basePath` (default `/askdepth/v1`):

| Method + path | Purpose |
|---|---|
| `GET /health` | contract version + advertised capabilities |
| `GET /schema` | your table's columns (postgres) or the declared schema (rest) |
| `POST /candidates/count` | count matching the criteria |
| `POST /candidates/search` | a page of mapped rows + a `nextCursor`, hard 1,000-row cap |

All four require a valid signature, GETs included.

## 5. Secret rotation

Accept two secrets during an overlap window:

```ts
createConnector({
  secret: process.env.AUDIENCE_CONNECTOR_SECRET_NEW!,
  previousSecret: process.env.AUDIENCE_CONNECTOR_SECRET_OLD!,
  // …
});
```

Verification tries `secret`, then `previousSecret`. Which one matched is never
reported on the wire. Drop `previousSecret` once Askdepth confirms the cutover.

## 6. Timeouts

Interactive requests get a 5s budget, background requests (`X-Askdepth-Mode:
background`) get 30s. On expiry the connector returns `504` and aborts the
adapter's work. Override with `timeouts: { interactiveMs, backgroundMs }`.

## 7. What the connector never does

- No write path — there is no code that emits anything but `SELECT`.
- No unmapped column in any response.
- No row data, credential, host or DSN in any error body — errors are a fixed
  `{ error: { code, message } }` with a per-code constant message.
- No outbound network call other than answering the request it was handed
  (and, for the `rest` adapter, calling the `fetch` function you supplied).
- No trace of a matched-but-not-recruited candidate — the connector stores
  nothing.
