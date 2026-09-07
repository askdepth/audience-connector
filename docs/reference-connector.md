# The reference connector

`packages/reference-connector` — a CI-startable, documented artifact that the
Askdepth **platform** integration tests (P4) run against.

## 1. What it is

A **genuine `@askdepth/audience-connector` instance**, not a mock. It calls the
built public package exactly as a client integrator would — real
`createConnector`, a real adapter (`postgresAdapter` or `restAdapter`), real
HMAC-SHA256 signature verification through the real Express shim — over a
**deterministic 5,000-row synthetic SaaS-shaped user base** (the S6 seed:
`reference_users`, `ref-00001 … ref-05000`, `user-NNNNN@example.com`). It is
never published to npm.

It is **one artifact serving three roles**:

- **CI fixture** — the platform's integration tests and the conformance gate run
  against it instead of a hand-rolled stub.
- **Sales demo** — a live connector to point the conformance CLI (or the
  platform) at, with no platform UI in the loop.
- **Reference implementation** — a client engineer reads `src/postgres-variant.ts`
  or `src/rest-variant.ts` to see what a correct, idiomatic connector looks like.

**Two variants over the same seed and the same field mapping:**

| variant | adapter | backend | default `PORT` | needs a DB? |
| --- | --- | --- | --- | --- |
| `postgres` | `postgresAdapter` | a real Postgres holding `seed/fixtures.sql` | `8787` | yes |
| `rest` | `restAdapter` | an in-process in-memory fixture backend (`src/rest-fixture-api.ts`), booted automatically | `8788` | no |

Running the full 15-case conformance suite against both produces the **same 15
results** — the proof that the connector's behaviour is a property of the SDK and
the mapping, not of one backend.

## 2. Run it locally

All commands assume the built public package is present:

```sh
pnpm --recursive run build      # the variants consume the *built* @askdepth/audience-connector
```

### Postgres variant — one command (Docker)

```sh
cd packages/reference-connector
docker compose up
```

Brings up `postgres:16` (auto-seeded from `seed/fixtures.sql`) and the connector
on `:8787`, signing with the throwaway secret `demo-reference-secret`.

### Demo scripts (URL + secret banner, stays up until Ctrl-C)

```sh
pnpm --filter @askdepth/reference-connector demo:postgres
pnpm --filter @askdepth/reference-connector demo:rest
```

### The exact `start:*` commands CI uses

```sh
# Postgres variant — prints `listening on :8787`
REFERENCE_SECRET=… DATABASE_URL=postgres://… \
  pnpm --filter @askdepth/reference-connector start:postgres

# rest variant — boots its own in-memory fixture backend, prints `listening on :8788`
REFERENCE_SECRET=… \
  pnpm --filter @askdepth/reference-connector start:rest
```

| env var | variant | required | meaning |
| --- | --- | --- | --- |
| `REFERENCE_SECRET` | both | **yes** | HMAC signing secret. No insecure default — the process refuses to start without it. |
| `DATABASE_URL` | `postgres` | **yes** | Postgres connection string for the seeded `reference_users` DB. `TEST_DATABASE_URL` is accepted as a fallback. |
| `PORT` | both | no | Listen port. Defaults to `8787` (postgres) / `8788` (rest). |
| `FIXTURE_API_URL` | `rest` | no | Point at an already-running fixture backend instead of booting one in-process. |

**Ready-signal.** Both `start:*` entrypoints print the literal line

```
listening on :<port>
```

to stdout once the HTTP listener is accepting connections (followed by a
`conformance url: …` line). CI, the demo scripts, and
`__tests__/entrypoints.test.ts` all wait for that exact prefix. The connector
route prefix is `/askdepth/v1`, so the base URL is
`http://<host>:<port>/askdepth/v1`.

`start:postgres` binds its HTTP listener **before** the `pg` pool dials out, so
it reaches `listening on :<port>` even when the database is unreachable — it only
needs `DATABASE_URL` to be *set*. It still refuses to start if `REFERENCE_SECRET`
or `DATABASE_URL` is missing.

## 3. The seed's field mapping

Exported from `packages/reference-connector/seed/generate.ts` and shared verbatim
by both variants. P4 code should not reverse-engineer this from a response.

| canonical wire field | store column |
| --- | --- |
| `externalId` | `external_id` |
| `email` | `email` |
| `signupAt` | `signup_at` |
| `segment` | `segment` |
| `isActive` | `is_active` |

| attribute | filterable | returnable |
| --- | --- | --- |
| `plan` | yes | yes |
| `country` | yes | **no** — filter-only |
| `deviceType` | yes | yes |

**Intentionally unmapped columns:** `internal_notes` and `crm_account_id` exist
in every row. They are visible to `GET /schema` (introspection is allowed) but
must **never** appear in a `/candidates/search` row or a `/candidates/count`
body. They are what the conformance CLI's `--unmapped-column` flags point the
data-leak case at.

## 4. For the platform team

- P4 SHOULD write its integration tests against **this reference connector**,
  started via `pnpm --filter @askdepth/reference-connector start:postgres` and
  `pnpm --filter @askdepth/reference-connector start:rest` — **not a hand-rolled
  stub**. A stub that the platform team maintains drifts from the real
  connector's behaviour, and green integration tests against a drifted stub
  certify nothing. This restates the roadmap §0.4 constraint in a doc a P4
  engineer will actually read: the thing the platform is tested against must be a
  real connector.

- `ask-depth`'s `apps/server` currently has **no dependency on
  `@askdepth/audience-contract`**. That is expected, not a bug. Adding it — from
  npm, `npm install @askdepth/audience-contract`, **not** a workspace path or a
  `file:` link — is the first thing P4 does. The contract package is the only
  shared code between the platform and a connector; the platform signs its
  requests and validates responses with it.

- The two variants and how CI verifies them:

  | variant | base URL | CI job | verification command |
  | --- | --- | --- | --- |
  | `postgres` | `http://localhost:8787/askdepth/v1` | `.github/workflows/ci.yml` → `reference-postgres` | `node packages/connector/dist/bin/conformance.js conformance --url http://localhost:8787/askdepth/v1 --secret "$REFERENCE_SECRET" --unmapped-column internal_notes --unmapped-column crm_account_id --filter-only-attribute country` |
  | `rest` | `http://localhost:8788/askdepth/v1` | `.github/workflows/ci.yml` → `reference-rest` | `node packages/connector/dist/bin/conformance.js conformance --url http://localhost:8788/askdepth/v1 --secret "$REFERENCE_SECRET" --unmapped-column internal_notes --unmapped-column crm_account_id --filter-only-attribute country` |

  Both CI jobs boot the variant, wait for `listening on :`, and run the
  conformance suite as a **blocking gate**. The CI jobs live in
  `.github/workflows/ci.yml` (`reference-postgres`, `reference-rest`).
  `packages/reference-connector/__tests__/entrypoints.test.ts` is a drift guard:
  it fails if those CI commands change without this doc being updated.

## 5. Demo framing

Point the conformance CLI (or, later, the platform) at a running variant and
walk the 15 cases. What to show:

- It is a **real connector** — the same `@askdepth/audience-connector` a client
  deploys, the same signature verification, the same adapter.
- The data is **synthetic and deterministic** — every email is `@example.com`,
  every `externalId` is `ref-NNNNN`, and the same seed produces byte-identical
  rows on every run. Nothing here is a real person.
- Both variants answer identically, so the story is "your connector, your
  backend" — Postgres or your own service — not "our database".

(S10 expands this section.)
