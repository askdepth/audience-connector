# Conformance suite

`npx @askdepth/audience-connector conformance --url <url> --secret <secret>`
runs the checklist in [`conformance-spec.md`](./conformance-spec.md) against a
deployed connector. The negative cases (N1–N8) are where the value is: a runner
that passes everything is worse than none, because it turns an untested
integration into a certified one.

## Flags

| flag | repeatable | purpose |
|---|---|---|
| `--url <url>` | no | Base URL of the connector, including its route prefix (`…/askdepth/v1`). |
| `--secret <secret>` | no | Active signing secret. |
| `--previous-secret <s>` | no | Previous signing secret, accepted during a rotation overlap. |
| `--case <id>` | yes | Run only the named case id(s). |
| `--unmapped-column <name>` | yes | A store column that exists in the backing data but is intentionally not in `fieldMapping`; case **N3** asserts it appears in no candidate-data response. |
| `--filter-only-attribute <name>` | yes | An attribute usable in `attr.*` criteria but never projected into a row payload (absent from `returnable`); case **P6** asserts it is absent from every response row. With none supplied, P6 keeps its built-in structural + auto-discovery behaviour. |
| `--json` | no | Emit machine-readable JSON instead of a table. |
| `--timeout-ms <n>` | no | Per-case timeout in milliseconds (default 5000). |

So the suite is itself under test. Every negative case ships with a
**deliberately-broken fixture** — a genuine connector instance (or, where the
frozen handler makes the violation otherwise unreachable, a signed fetch-seam
that delegates every unrelated request to one) that commits *exactly* the one
violation its name says and is otherwise fully correct.
`__tests__/conformance-meta-check.test.ts` runs the full 15-case suite against
each fixture and asserts that **only** the named case fails.

This page will be expanded in S10. For now it is the case → fixture map.

## Negative case → broken fixture

| id | a connector fails if it… | broken fixture | the one violation it commits |
|---|---|---|---|
| N1 | answers an unsigned request | [`__tests__/fixtures/unsigned-ok/`](../packages/connector/__tests__/fixtures/unsigned-ok/index.ts) | a handler wrapper that mints a signature for an unsigned request instead of rejecting it |
| N2 | answers a request with an expired or malformed signature | [`__tests__/fixtures/weak-signature/`](../packages/connector/__tests__/fixtures/weak-signature/index.ts) | verification present but with a non-timing-safe compare and a 24h (vs ±300s) window, so a stale signature is accepted |
| N3 | returns unmapped columns | [`__tests__/fixtures/leaky-columns/`](../packages/connector/__tests__/fixtures/leaky-columns/index.ts) | an adapter that ignores `select` and splices an unmapped store column (`internal_notes`) onto every search row |
| N4 | leaks credentials or row data in an error response | [`__tests__/fixtures/leaky-errors/`](../packages/connector/__tests__/fixtures/leaky-errors/index.ts) | a seam that lets a raw driver error — fake connection string and a row fragment — reach the error body unredacted |
| N5 | returns non-deterministic cursor pagination | [`__tests__/fixtures/nondeterministic-cursor/`](../packages/connector/__tests__/fixtures/nondeterministic-cursor/index.ts) | an adapter that re-orders the whole result set per request and ignores `plan.after` |
| N6 | exceeds the 1,000-row result cap | [`__tests__/fixtures/no-row-cap/`](../packages/connector/__tests__/fixtures/no-row-cap/index.ts) | a fetch-seam that returns 1,500 rows in a single body for an at-cap request (the frozen handler's defensive slice makes this unreachable through `createConnector`) |
| N7 | returns a non-random subsample when `randomSample` is advertised | [`__tests__/fixtures/fake-random-sample/`](../packages/connector/__tests__/fixtures/fake-random-sample/index.ts) | an adapter that answers a `sample` request with the oldest N rows by signup order |
| N8 | exposes any write path | [`__tests__/fixtures/write-path-exposed/`](../packages/connector/__tests__/fixtures/write-path-exposed/index.ts) | an extra `DELETE /candidates/:id` route mounted beside the connector that answers 200 |

The shared seeded base for these fixtures is
[`__tests__/fixtures/_seed.ts`](../packages/connector/__tests__/fixtures/_seed.ts)
— 900 deterministic rows, monotonic `signupAt`, a filter-only `attr.plan`, a
returnable `attr.tier`, and two columns (`internal_notes`, `secret_note`) that
exist in the data but are not mapped.

## Positive cases

`health`, `schema`, `count`, `search`, `externalId IN`, attribute filters,
`suppressExternalIds` (P1–P7). They prove the happy path against the correct
reference fixture (`referenceClient()` in `_seed.ts`); necessary but not
sufficient — the negative cases above are the point.
