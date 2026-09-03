# Conformance self-check

Maps every case in [`conformance-spec.md`](./conformance-spec.md) to the
test(s) in this repo that cover it. `conformance-spec.md` is the P1 grading
checklist for a *third-party* connector; this package must make every case
true of itself. The P3 `conformance` CLI will execute the checklist against an
arbitrary connector — this table is what makes it visible when a case is only
*believed* to be covered.

Case ids: `N1`–`N8` are the "a connector fails if it…" list; `P1`–`P7` are the
"a connector must pass" list, in spec order.

## Negative cases — a connector fails if it…

| id | case | covered by |
|---|---|---|
| N1 | answers an unsigned request | `verify-request.test.ts` › S3.2/S3.3/S3.11 (adapter spy never invoked); `handler.test.ts` › S4.4 (ordering); `shims.test.ts` › S8.6; `runtime.test.ts` › unsigned → 401 |
| N2 | answers a request with an expired or malformed signature | `verify-request.test.ts` › S3.6 (±300s boundary), S3.7 (NaN/Infinity/empty), S3.8 (wrong bytes / wrong length) |
| N3 | returns unmapped columns | `postgres.test.ts` › S6.3 (`secret_note` never returned) + S6.2 (no `SELECT *`); `rest.test.ts` › S7.2 (over-returning client stripped); `plan.test.ts` › S5.7 (`select` ⊆ `fieldMapping`) |
| N4 | leaks credentials or row data in an error response | `errors.test.ts` › S2.3/S2.4/S2.5 (DSN/email/row/token never in body); `postgres.test.ts` › S6.15 (dead pool, no host/DSN); `rest.test.ts` › S7.5 (Bearer/DSN in client throw) |
| N5 | returns non-deterministic cursor pagination | `plan.test.ts` › S5.12 (seed reused), S5.14 (same seed → same order); `postgres.test.ts` › S6.10 (no dupes/gaps), S6.11 (same cursor → identical rows) |
| N6 | exceeds the 1,000-row result cap | `handler.test.ts` › S4.8 (limit 1001 → `limit_exceeded`); `postgres.test.ts` › S6.13 (`LIMIT $n` + defensive slice); `rest.test.ts` › S7.3 (truncation) |
| N7 | returns a non-random subsample when `randomSample` is advertised | `plan.test.ts` › S5.13 (mean signupAt percentile ≈ 0.5 over 5 fixed seeds, not the oldest 100) |
| N8 | exposes any write path | `postgres.test.ts` › S6.2 (no `SELECT *`), S6.4 (every statement BEGIN/SELECT/SET LOCAL/COMMIT/ROLLBACK; no write keyword), S6.5 (`'); DROP TABLE` arrives as a bound param, table survives) |

## Positive cases — a connector must pass, to activate

| id | case | covered by |
|---|---|---|
| P1 | `GET /health` returns 200 with a valid `HealthResponseSchema` body | `handler.test.ts` › S4.1/S4.2 (contract-sourced version); `runtime.test.ts` › Next.js + Cloud Functions health |
| P2 | `GET /schema` returns `columns` (postgres) or the hand-declared schema (rest) | `postgres.test.ts` › S6.16 (all real columns + types); `rest.test.ts` › S7.1 (verbatim, key order) |
| P3 | `POST /candidates/count` returns a non-negative integer for a valid query | `handler.test.ts` › S4.1; `postgres.test.ts` › S6.7 (matches a hand-written reference over 6 criteria combos) |
| P4 | `POST /candidates/search` respects `limit` and returns a `cursor` when more rows exist | `handler.test.ts` › S4.1/S4.8; `postgres.test.ts` › S6.10 (10 pages, cursor undefined on the last); S6.1 (cursor decodes to this query's hash/seed) |
| P5 | `externalId IN [...]` criteria return the correct intersection | `plan.test.ts` › S5.1 (`externalId in` → `PlannedFilter`); `postgres.test.ts` › S6.7 |
| P6 | attribute filters filter without the attribute appearing, unless separately mapped for display | `plan.test.ts` › S5.4 (filterable-not-returnable absent from `select`), S5.5 (returnable in both); `postgres.test.ts` › S6.9; `rest.test.ts` › S7.2 |
| P7 | `suppressExternalIds` excludes the named ids from results | `postgres.test.ts` › S6.8 (500-id exactness + 1,000-id → count 0, array parameter) |
