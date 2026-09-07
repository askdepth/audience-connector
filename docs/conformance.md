# Conformance suite

`audience-connector conformance --url <url> --secret <secret>` runs the
checklist in [`conformance-spec.md`](./conformance-spec.md) against a deployed
connector. The negative cases (N1–N8) are where the value is: a runner that
passes everything is worse than none, because it turns an untested integration
into a certified one.

**It is a blocking gate.** In the P6 activation wizard (step 7) a connector
does not activate without a clean conformance run — every one of the 15 cases
passing. There is no skip, no warn-only mode, and no bypass flag; a single
failing case blocks activation.

## Case list

The suite runs 15 cases — 7 positive (`P1`–`P7`, the "a connector must pass, to
activate" list) and 8 negative (`N1`–`N8`, the "a connector fails if it…"
list), both in [`conformance-spec.md`](./conformance-spec.md) order.

### Positive — a connector must pass all of these

| id | case |
|---|---|
| P1 | `GET /health` returns 200 with a valid `HealthResponseSchema` body. |
| P2 | `GET /schema` returns `columns` (postgres) or the hand-declared schema (rest). |
| P3 | `POST /candidates/count` returns a non-negative integer for a valid query. |
| P4 | `POST /candidates/search` respects `limit` and returns a `cursor` when more rows exist. |
| P5 | `externalId IN [...]` criteria return the correct intersection. |
| P6 | Attribute filters (`attr.*`) filter without the attribute appearing in the response, unless separately mapped for display (§4.3). |
| P7 | `suppressExternalIds` excludes the named ids from results. |

### Negative — a connector fails if it does any of these

The one-line statement of each negative case, its deliberately-broken fixture,
and the exact violation that fixture commits are in the
[**Negative case → broken fixture**](#negative-case--broken-fixture) table
below. In short: N1 answers an unsigned request; N2 answers a request with an
expired or malformed signature; N3 returns unmapped columns; N4 leaks
credentials or row data in an error response; N5 returns non-deterministic
cursor pagination; N6 exceeds the 1,000-row result cap; N7 returns a
non-random subsample when `randomSample` is advertised; N8 exposes any write
path.

## Getting the CLI

The runner ships **inside the `@askdepth/audience-connector` package** as a
`bin` (`audience-connector` → `dist/bin/conformance.js`). Once the package is
installed it runs as `audience-connector conformance …`, or
`npx audience-connector conformance …` from a project that depends on it — no
separate install, no workspace context required.

Packaging is verified end to end (S9.5): `npm pack` the connector workspace,
`npm install` the resulting tarball into a clean directory **outside this
repo**, and the installed `node_modules/.bin/audience-connector` runs the full
15-case suite with byte-for-byte the same results as the workspace build. The
`__tests__/cli-packaging.test.ts` guard keeps a future `files`/tsup change from
silently dropping the bin from the tarball.

> **Open item — registry `0.1.0` predates the CLI.** The `0.1.0` of
> `@askdepth/audience-connector` currently on the public npm registry was
> published at the end of P2, before the conformance CLI existed, so its
> tarball has no `bin` — `npx @askdepth/audience-connector conformance` fetched
> fresh from the registry fails with *"could not determine executable to
> run"*. Closing that needs a `0.1.1` publish, which is a human release
> decision and **not part of P3**. Until it lands, consumers install the CLI
> from a build of this repo (or a locally packed tarball).

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

## `--json` output shape (for CI)

With `--json` the runner writes a single JSON object to stdout:

```jsonc
{
  "url": "https://connector.example.com/askdepth/v1",
  "cases": [
    { "id": "P1", "pass": true },
    { "id": "N4", "pass": false, "detail": "DSN fragment observed in error body" }
    // …one entry per case run, in suite order
  ],
  "passed": 14,
  "failed": 1
}
```

- `url` — the `--url` the run targeted.
- `cases` — one `{ id, pass, detail? }` per case actually run (all 15 by
  default; only the `--case` ids when that flag is given). `detail` is present
  on a failure and on some passes that carry a note; treat it as human-readable
  text, not a stable field.
- `passed` / `failed` — counts over `cases`.

**Exit codes:**

| code | meaning |
|---|---|
| `0` | every case run passed |
| `1` | at least one case failed (a real conformance failure) |
| `2` | runner error — bad or non-http(s) `--url`, connector unreachable, unknown `--case` id, malformed flag |

CI must branch on the **exit code**, not parse stdout. Exit `2` is an
infrastructure problem (the run never produced a verdict); exit `1` is the
connector failing conformance. Only exit `0` is a pass.

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

### N7 is a statistical assertion — allow one retry in CI

N7 does not check a single response. It advertises `randomSample`, draws a
subsample repeatedly, and checks that the **mean percentile of a monotonic
field (`signupAt`) across the draws falls inside a band around 0.5** — a
non-random connector that returns, say, the oldest N rows lands far outside it.

The suite's own CI is deterministic: it pins the sampling RNG, so N7 is a
fixed pass/fail there. Run against a **live** connector the draws are genuinely
random, so a correct connector will occasionally produce a run whose mean lands
just outside the band by chance. CI that runs the suite against a real
connector should **allow exactly one retry for N7 specifically** (e.g.
`--case N7` re-run on a first N7 failure) before treating it as a real failure.
Do not blanket-retry the whole suite — the other 14 cases are deterministic and
a retry there would only mask a real regression.

## Positive cases

`health`, `schema`, `count`, `search`, `externalId IN`, attribute filters,
`suppressExternalIds` (P1–P7 — full one-liners in the [case list](#case-list)
above). They prove the happy path against the correct reference fixture
(`referenceClient()` in `_seed.ts`); necessary but not sufficient — the
negative cases above are the point.
