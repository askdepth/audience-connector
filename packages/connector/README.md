# @askdepth/audience-connector

The client-side connector for Askdepth's audience layer. A research on the
Askdepth platform sends this connector a signed criteria query; it runs inside
**your** infrastructure, against **your** database, and answers with counts and
a capped, column-mapped, read-only result set. Your raw data and your database
credentials never leave your perimeter.

- Web-standard `Request → Response` handler; framework shims are thin wrappers.
- **Zero runtime dependencies** in core. `pg` is an optional peer.
- Mandatory HMAC-SHA256 verification — no local-testing bypass.
- Dual ESM/CJS.

Full deployment guide: [`docs/deployment.md`](../../docs/deployment.md).
Runtime matrix: [`docs/runtime-support.md`](../../docs/runtime-support.md).

## Public API

```ts
import {
  createConnector,
  postgresAdapter,
  restAdapter,
  CONTRACT_VERSION,
} from '@askdepth/audience-connector';

import { expressHandler } from '@askdepth/audience-connector/express';
import { fastifyPlugin } from '@askdepth/audience-connector/fastify';
import { lambdaHandler } from '@askdepth/audience-connector/lambda';
```

### `createConnector(config): { fetch(request: Request): Promise<Response> }`

| config field | | |
|---|---|---|
| `secret` | `string \| Buffer` | signing secret issued by Askdepth |
| `previousSecret?` | `string \| Buffer` | accepted during a rotation overlap |
| `adapter` | `Adapter` | `postgresAdapter(…)` or `restAdapter(…)` |
| `fieldMapping` | `Partial<Record<CanonicalField, string>>` | canonical field → your column. The whitelist. |
| `attributes?` | `{ filterable: string[]; returnable?: string[] }` | `attr.*` fields; ≤10 filterable; filter-only unless returnable |
| `capabilities?` | `Partial<Record<CapabilityFlag, boolean>>` | narrows the adapter's advertised set (cannot widen) |
| `basePath?` | `string` | default `/askdepth/v1` |
| `timeouts?` | `{ interactiveMs?: number; backgroundMs?: number }` | default 5 000 / 30 000 |

### `postgresAdapter(opts): Adapter`

`{ pool: pg.Pool, table: string, schema?: string, externalIdColumn?: string, maxStatementTimeoutMs?: number }`

Compiles the criteria DSL to parameterised, read-only `SELECT` over mapped
columns only. You pass your own `pg.Pool`; this package never constructs one
or sees a connection string.

### `restAdapter(opts): Adapter`

`{ fetchCandidates, declaredSchema, fetchCount?, capabilities? }`

For non-Postgres backends. You supply the function that talks to your system;
the adapter re-enforces every invariant on its output (strip unmapped keys,
1 000-row cap, per-row canonical-schema validation, abort over partial).

### Shims

| import | returns |
|---|---|
| `@askdepth/audience-connector/express` → `expressHandler(connector)` | Express `RequestHandler` — mount behind `express.raw({ type: 'application/json' })` |
| `@askdepth/audience-connector/fastify` → `fastifyPlugin(connector)` | `FastifyPluginAsync` — installs a raw-buffer content-type parser |
| `@askdepth/audience-connector/lambda` → `lambdaHandler(connector)` | API Gateway HTTP API v2 handler; honours `isBase64Encoded` |

## Endpoints

`GET /health` · `GET /schema` · `POST /candidates/count` ·
`POST /candidates/search` — all under `basePath`, all requiring a valid
signature. Deterministic cursor pagination, hard 1 000-row cap, random
subsample only.
