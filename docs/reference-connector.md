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

### Running the variant tests (they seed + drop `reference_users`)

`__tests__/postgres-variant.test.ts` and the `/schema` cross-check in
`__tests__/rest-variant.test.ts` are gated on a real Postgres. **They run
`seed/fixtures.sql` — which begins `DROP TABLE IF EXISTS "reference_users"` —
and drop the table again in teardown**, so point them only at a disposable
database.

They resolve the DB URL in this order:

1. `REFERENCE_CONNECTOR_TEST_DB_URL` — the dedicated, explicit opt-in. **Prefer
   this.**
2. `TEST_DATABASE_URL`
3. `DATABASE_URL`

A destructive-seed guard refuses to run the DROP/CREATE unless either
`REFERENCE_CONNECTOR_TEST_DB_URL` was the source, or the resolved DSN's database
name unmistakably names a test DB (matches
`/(^|[_-])test($|[_-])|_test\d*$|test_?ref|reference_test/i`). When the guard
fails the tests **skip** locally (with a console note) and **throw** in CI (so a
misconfigured pipeline is loud). This is what keeps a developer whose
`DATABASE_URL` points at a real database from losing `reference_users` — set
`REFERENCE_CONNECTOR_TEST_DB_URL` to a throwaway Postgres to run them:

```sh
REFERENCE_CONNECTOR_TEST_DB_URL=postgres://postgres:postgres@127.0.0.1:55432/reference_test \
  pnpm --filter @askdepth/reference-connector test
```

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

## 5. For a demo

The reference connector is the **M2 deliverable**: a working, demonstrable
connector that sales can show *now*, without waiting for any platform UI. Point
the conformance CLI at a running variant and walk it live.

### What it actually is

- A **real connector instance**, not a mock and not a stub. It is the same
  `@askdepth/audience-connector` package a client deploys, wired to a real
  adapter (`postgresAdapter` or `restAdapter`), doing real HMAC-SHA256
  signature verification through the real framework shim. There is no
  demo-only code path — what the audience sees is what a client ships.
- The seed is **synthetic and deterministic**: 5,000 SaaS-shaped users spread
  over roughly 18 months of signups, every email `user-NNNNN@example.com`,
  every `externalId` `ref-NNNNN`. The same seed produces byte-identical rows on
  every run, on every machine. Nothing here is or resembles a real person, so
  it is safe to show on a shared screen.

### What to show

1. **A signed round-trip.** Run `POST /candidates/count` and
   `POST /candidates/search` through the conformance CLI (or `curl` with a
   signed header). Unsigned or stale-signature requests are rejected — that is
   cases N1/N2 passing, live.
2. **The schema.** `GET /schema` returns the connector's declared columns and
   attributes — the platform learns the shape by asking, not by configuration.
3. **Unmapped columns never leak.** `internal_notes` and `crm_account_id` exist
   in every backing row and show up in `GET /schema`, but never appear in a
   `/candidates/search` row or a `/candidates/count` body. That is case N3
   passing against real data.
4. **Same queries, both variants, same answers.** Run the identical query set
   against the `postgres` variant (`:8787`) and the `rest` variant (`:8788`).
   The response shapes and row counts match. The story is "your connector, your
   backend — Postgres or your own service", not "our database": the connector's
   behaviour is a property of the SDK and the field mapping, not of one
   backend.
5. **The full gate.** Run all 15 conformance cases against the running variant
   and show a clean pass — the same gate a client's connector must clear in the
   P6 activation wizard before it can point at production.

The `rest` variant needs no database (`pnpm --filter
@askdepth/reference-connector demo:rest`), so it is the fastest thing to bring
up on a laptop for a demo.
