// Deterministic synthetic dataset for the Askdepth reference connector.
//
// ONE dataset + ONE canonical field mapping, shared by BOTH reference-connector
// variants (the postgres variant, S7; the rest variant, S8). Data only — no
// connector logic lives here.
//
// The base is a generic SaaS-shaped user table: 5,000 users signing up over an
// ~18-month window, each on a plan, in a country, using a device type, in a
// lifecycle segment. This is the FINAL shape (spec §0.7 internal dogfooding),
// not a placeholder.
//
// ── Canonical field mapping ────────────────────────────────────────────────
// Canonical wire field   store column      role
//   externalId           external_id       identity, stable, insertion-ordered
//   email                email             synthetic, <slug>@example.com
//   signupAt             signup_at         timestamptz, monotonic, ~18mo span
//   segment              segment           categorical, 6 lifecycle values
//   isActive             is_active         boolean
//
// ── Attributes (attr.*) ────────────────────────────────────────────────────
//   plan                 plan              FILTERABLE + RETURNABLE (display-mapped)
//   country              country           FILTERABLE only (never in a row payload)
//   deviceType           deviceType        FILTERABLE + RETURNABLE (display-mapped)
//
// Attribute name == store column name (the connector's `attributes` config has
// no column-mapping layer). `deviceType` is a quoted camelCase identifier in
// Postgres — valid under the adapter's `^[A-Za-z_][A-Za-z0-9_$]*$` allowlist.
//
// ── Columns present in the store but ABSENT from `fieldMapping` ─────────────
//   internal_notes       free-text operator notes — must never reach a row payload
//   crm_account_id       opaque CRM id      — must never reach a row payload
//
// As of conformance S5, case N3 grades candidate-*data* responses only, not
// `/schema`. It is therefore fine for the postgres variant's `/schema` to later
// introspect these two columns; they must simply never appear in a
// `/candidates/search` row. Pass them to the CI conformance job as
// `--unmapped-column internal_notes --unmapped-column crm_account_id`.
//
// ── Regenerate ─────────────────────────────────────────────────────────────
//   pnpm --filter @askdepth/reference-connector seed:generate
// re-emits `seed/fixtures.sql` from the fixed seed. A drift-guard test fails if
// the checked-in file no longer matches.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Fixed default seed. Tests may pass an override. */
export const DEFAULT_SEED = 0x5eed_1000;

/** Exact row count (spec §S6). */
export const ROW_COUNT = 5000;

/** Postgres table name — the S7 postgres variant expects exactly this. */
export const TABLE_NAME = 'reference_users';

/** signupAt window: 2024-01-01 .. 2025-07-01 (18 calendar months). */
const SIGNUP_START_MS = Date.UTC(2024, 0, 1, 0, 0, 0);
const SIGNUP_END_MS = Date.UTC(2025, 6, 1, 0, 0, 0);

/** Canonical wire field -> store column. Attributes are NOT here (see header). */
export const fieldMapping = {
  externalId: 'external_id',
  email: 'email',
  signupAt: 'signup_at',
  segment: 'segment',
  isActive: 'is_active',
} as const;

/**
 * Attribute config for `createConnector`.
 *  - `filterable`: usable in `attr.*` criteria.
 *  - `returnable`: additionally allowed to appear in a row payload (display-mapped).
 * `country` is deliberately filter-only.
 */
export const attributes = {
  filterable: ['plan', 'country', 'deviceType'],
  returnable: ['plan', 'deviceType'],
} as const;

/** Store columns that exist in every row but are intentionally unmapped. */
export const unmappedColumns = ['internal_notes', 'crm_account_id'] as const;

/** Store column names in table / INSERT order. */
export const columns = [
  'external_id',
  'email',
  'signup_at',
  'segment',
  'is_active',
  'plan',
  'country',
  'deviceType',
  'internal_notes',
  'crm_account_id',
] as const;

const SEGMENTS = ['trial', 'starter', 'growth', 'scale', 'enterprise', 'churned'] as const;
const PLANS = ['free', 'pro', 'business', 'enterprise'] as const;
const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'IN', 'BR'] as const;
const DEVICE_TYPES = ['web', 'ios', 'android'] as const;
const NOTE_STATES = ['ok', 'stale', 'pending', 'review'] as const;

export interface ReferenceUserRow {
  external_id: string;
  email: string;
  signup_at: string;
  segment: string;
  is_active: boolean;
  plan: string;
  country: string;
  deviceType: string;
  internal_notes: string;
  crm_account_id: string;
}

/** Deterministic PRNG — mulberry32 (same style as the S4/S5 conformance fixtures). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))];
}

/**
 * The raw store rows, keyed by store column name (1:1 with the SQL table and
 * with the rest variant's declared schema). Deterministic for a given seed.
 *
 * `signup_at` is strictly increasing with insertion order: row 0 is exactly
 * SIGNUP_START_MS, row ROW_COUNT-1 is exactly SIGNUP_END_MS, and the step
 * (~9.45M ms) is far larger than 1ms so the sequence never repeats. That gives
 * the sampling-distribution test a real ~18-month band to bucket.
 */
export function generateRows(seed: number = DEFAULT_SEED, count: number = ROW_COUNT): ReferenceUserRow[] {
  const rnd = mulberry32(seed);
  const spanMs = SIGNUP_END_MS - SIGNUP_START_MS;
  const rows: ReferenceUserRow[] = [];
  for (let i = 0; i < count; i++) {
    // Fixed RNG draw order — changing it changes the dataset bytes.
    const segR = rnd();
    const activeR = rnd();
    const planR = rnd();
    const countryR = rnd();
    const deviceR = rnd();
    const noteR = rnd();
    const crmR = rnd();

    const n = i + 1;
    const id = `ref-${String(n).padStart(5, '0')}`;
    const signupMs = SIGNUP_START_MS + Math.round((i * spanMs) / (count - 1));

    rows.push({
      external_id: id,
      email: `user-${String(n).padStart(5, '0')}@example.com`,
      signup_at: new Date(signupMs).toISOString(),
      segment: pick(SEGMENTS, segR),
      is_active: activeR < 0.82,
      plan: pick(PLANS, planR),
      country: pick(COUNTRIES, countryR),
      deviceType: pick(DEVICE_TYPES, deviceR),
      internal_notes: `crm-sync ${pick(NOTE_STATES, noteR)} for ${id}`,
      crm_account_id: `CRM-${String(100000 + Math.floor(crmR * 900000)).padStart(6, '0')}`,
    });
  }
  return rows;
}

/** Everything a variant / the CI conformance job needs, in one object. */
export function generate(seed: number = DEFAULT_SEED) {
  return {
    seed,
    rowCount: ROW_COUNT,
    table: TABLE_NAME,
    columns: [...columns],
    fieldMapping,
    attributes,
    unmappedColumns: [...unmappedColumns],
    rows: generateRows(seed),
  };
}

// ── SQL emission ───────────────────────────────────────────────────────────

const qi = (name: string): string => `"${name}"`;

function sqlLiteral(value: string | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${value.replace(/'/g, "''")}'`;
}

const DDL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['external_id', 'text        NOT NULL PRIMARY KEY'],
  ['email', 'text        NOT NULL'],
  ['signup_at', 'timestamptz NOT NULL'],
  ['segment', 'text        NOT NULL'],
  ['is_active', 'boolean     NOT NULL'],
  ['plan', 'text        NOT NULL'],
  ['country', 'text        NOT NULL'],
  ['deviceType', 'text        NOT NULL'],
  ['internal_notes', 'text        NOT NULL'],
  ['crm_account_id', 'text        NOT NULL'],
];

/**
 * A deterministic Postgres seed file: DROP + CREATE + one multi-row INSERT.
 * Same seed => same rows => byte-identical string => reviewable PR diff.
 */
export function emitSql(rows: ReferenceUserRow[], seed: number = DEFAULT_SEED): string {
  const colList = columns.map(qi).join(', ');
  const seedHex = `0x${(seed >>> 0).toString(16)}`;

  const ddl = DDL_COLUMNS.map(([name, type], i) => {
    const comma = i === DDL_COLUMNS.length - 1 ? '' : ',';
    return `  ${qi(name).padEnd(18)} ${type}${comma}`;
  }).join('\n');

  const values = rows
    .map((row) => {
      const tuple = columns.map((c) => sqlLiteral(row[c as keyof ReferenceUserRow])).join(', ');
      return `  (${tuple})`;
    })
    .join(',\n');

  return (
    `-- GENERATED by seed/generate.ts — DO NOT EDIT BY HAND.\n` +
    `-- Regenerate: pnpm --filter @askdepth/reference-connector seed:generate\n` +
    `-- seed=${seedHex}  rows=${rows.length}  signup_at span: ${rows[0]?.signup_at} .. ${rows[rows.length - 1]?.signup_at}\n` +
    `\n` +
    `DROP TABLE IF EXISTS ${qi(TABLE_NAME)};\n` +
    `\n` +
    `CREATE TABLE ${qi(TABLE_NAME)} (\n${ddl}\n);\n` +
    `\n` +
    `INSERT INTO ${qi(TABLE_NAME)}\n  (${colList})\nVALUES\n${values};\n`
  );
}

/** Absolute path to the checked-in seed file. */
export function fixturesSqlPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'fixtures.sql');
}

// ── Entrypoint: (re)write seed/fixtures.sql ────────────────────────────────

function isMain(): boolean {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
}

if (isMain()) {
  const rows = generateRows();
  const sql = emitSql(rows);
  const out = fixturesSqlPath();
  writeFileSync(out, sql);
  const span = Date.parse(rows[rows.length - 1].signup_at) - Date.parse(rows[0].signup_at);
  const spanDays = Math.round(span / 86_400_000);
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${out}\n  rows=${rows.length}  seed=0x${DEFAULT_SEED.toString(16)}  signup_at span=${spanDays}d ` +
      `(${rows[0].signup_at} .. ${rows[rows.length - 1].signup_at})`,
  );
}
