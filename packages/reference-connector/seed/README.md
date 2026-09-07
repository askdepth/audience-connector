# Reference connector — seed dataset

One deterministic synthetic dataset, shared by **both** reference-connector
variants (postgres, S7; rest, S8). Data only — no connector logic here.

## What it represents

A generic SaaS-shaped user base: **5,000 users** who signed up over an
**~18-month window** (2024-01-01 → 2025-07-01), each on a plan, in a country,
using a device type, in a lifecycle segment. This is the final internal
dogfooding shape (spec §0.7), not a placeholder.

Everything is synthetic: ids are `ref-00001`…`ref-05000`, emails are
`user-NNNNN@example.com`.

## Canonical field mapping

| canonical wire field | store column | notes |
|---|---|---|
| `externalId` | `external_id` | stable, insertion-ordered |
| `email` | `email` | synthetic `@example.com` |
| `signupAt` | `signup_at` | `timestamptz`, strictly increasing, ~547-day span |
| `segment` | `segment` | 6 values: `trial`, `starter`, `growth`, `scale`, `enterprise`, `churned` |
| `isActive` | `is_active` | boolean (~82% true) |

## Attributes (`attr.*`)

| attribute | store column | role |
|---|---|---|
| `plan` | `plan` | filterable **and** returnable (display-mapped) — `free` / `pro` / `business` / `enterprise` |
| `country` | `country` | **filter-only** — never appears in a row payload — 8 ISO-ish codes |
| `deviceType` | `deviceType` | filterable **and** returnable (display-mapped) — `web` / `ios` / `android` |

Attribute name equals store column name (the connector's `attributes` config has
no column-mapping layer). `deviceType` is a quoted camelCase Postgres identifier,
valid under the adapter's identifier allowlist.

## Columns present in the store but NOT in `fieldMapping`

- `internal_notes` — free-text operator notes
- `crm_account_id` — opaque CRM id (`CRM-NNNNNN`)

Conformance case **N3** (as of S5) grades candidate-*data* responses only, not
`/schema`. The postgres variant's `/schema` may introspect these columns; they
must simply never reach a `/candidates/search` row. Pass them to the CI
conformance job:

```
--unmapped-column internal_notes --unmapped-column crm_account_id
```

`generate.ts` exports `unmappedColumns` for exactly this.

## Regenerate

```
pnpm --filter @askdepth/reference-connector seed:generate
```

Re-emits `seed/fixtures.sql` from the fixed seed (`0x5eed1000`). The dataset is a
pure function of that seed, so the file is byte-stable and reviewable in the PR
diff. A drift-guard test (`__tests__/dataset.test.ts`) fails if the checked-in
file no longer matches the generator output.
