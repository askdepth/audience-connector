// S6 — the seeded synthetic dataset is itself under test.
//
// Data only this stage: these assert the generator is deterministic, the row
// shape matches the canonical mapping, the signupAt window is wide enough for a
// sampling-distribution test to have a meaningful percentile band, and the
// checked-in `seed/fixtures.sql` has not drifted from what `generate.ts` emits.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SEED,
  ROW_COUNT,
  TABLE_NAME,
  fieldMapping,
  attributes,
  unmappedColumns,
  columns,
  generate,
  generateRows,
  emitSql,
  fixturesSqlPath,
  type ReferenceUserRow,
} from '../seed/generate';

const CANONICAL_FIELDS = ['external_id', 'email', 'signup_at', 'segment', 'is_active'] as const;
const ATTR_COLUMNS = ['plan', 'country', 'deviceType'] as const;

describe('determinism', () => {
  it('generate() twice with the same seed is byte-identical (JSON)', () => {
    const a = JSON.stringify(generate(DEFAULT_SEED));
    const b = JSON.stringify(generate(DEFAULT_SEED));
    expect(a).toBe(b);
  });

  it('generate() deep-equals across runs', () => {
    expect(generate(DEFAULT_SEED)).toEqual(generate(DEFAULT_SEED));
  });

  it('emitSql() twice is the identical string', () => {
    expect(emitSql(generateRows())).toBe(emitSql(generateRows()));
  });

  it('a different seed produces a different dataset', () => {
    expect(JSON.stringify(generate(DEFAULT_SEED))).not.toBe(JSON.stringify(generate(DEFAULT_SEED + 1)));
  });
});

describe('row count and shape', () => {
  const rows = generateRows();

  it('has exactly 5,000 rows', () => {
    expect(rows).toHaveLength(5000);
    expect(ROW_COUNT).toBe(5000);
  });

  it('externalId is stable and insertion-ordered (ref-00001 ..)', () => {
    expect(rows[0].external_id).toBe('ref-00001');
    expect(rows[4999].external_id).toBe('ref-05000');
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i].external_id).toBe(`ref-${String(i + 1).padStart(5, '0')}`);
    }
  });

  it('email is synthetic @example.com on every row', () => {
    for (const row of rows) {
      expect(row.email).toMatch(/^user-\d{5}@example\.com$/);
    }
  });

  it('every canonical field is present on every row', () => {
    for (const row of rows) {
      for (const field of CANONICAL_FIELDS) {
        expect(row[field as keyof ReferenceUserRow]).not.toBeUndefined();
      }
      expect(typeof row.is_active).toBe('boolean');
    }
  });

  it('every attr.* column is present on every row', () => {
    for (const row of rows) {
      for (const attr of ATTR_COLUMNS) {
        expect(typeof row[attr as keyof ReferenceUserRow]).toBe('string');
        expect(row[attr as keyof ReferenceUserRow]).not.toBe('');
      }
    }
  });

  it('the two unmapped columns are present in the raw store rows', () => {
    expect(unmappedColumns).toEqual(['internal_notes', 'crm_account_id']);
    for (const row of rows) {
      expect(typeof row.internal_notes).toBe('string');
      expect(row.crm_account_id).toMatch(/^CRM-\d{6}$/);
    }
  });

  it('the unmapped columns are ABSENT from fieldMapping (values and keys)', () => {
    const mappedColumns = Object.values(fieldMapping) as string[];
    const mappedKeys = Object.keys(fieldMapping);
    for (const col of unmappedColumns) {
      expect(mappedColumns).not.toContain(col);
      expect(mappedKeys).not.toContain(col);
    }
    // ...and absent from the returnable attribute list too.
    expect(attributes.returnable as readonly string[]).not.toContain('internal_notes');
    expect(attributes.returnable as readonly string[]).not.toContain('crm_account_id');
  });

  it('fieldMapping covers exactly the five canonical wire fields', () => {
    expect(Object.keys(fieldMapping).sort()).toEqual(
      ['email', 'externalId', 'isActive', 'segment', 'signupAt'].sort(),
    );
    expect(Object.values(fieldMapping)).toEqual([...CANONICAL_FIELDS]);
  });

  it('country is filter-only; plan and deviceType are display-mapped', () => {
    expect(attributes.filterable).toEqual(['plan', 'country', 'deviceType']);
    expect(attributes.returnable).toEqual(['plan', 'deviceType']);
    expect(attributes.returnable as readonly string[]).not.toContain('country');
  });

  it('the raw store row carries no keys beyond the declared columns', () => {
    for (const row of rows.slice(0, 50)) {
      expect(Object.keys(row).sort()).toEqual([...columns].sort());
    }
  });
});

describe('signupAt window and segment cardinality', () => {
  const rows = generateRows();

  it('signup_at is strictly increasing with insertion order', () => {
    for (let i = 1; i < rows.length; i++) {
      expect(Date.parse(rows[i].signup_at)).toBeGreaterThan(Date.parse(rows[i - 1].signup_at));
    }
  });

  it('signup_at spans ~18 months — wide enough for a percentile band', () => {
    const min = Date.parse(rows[0].signup_at);
    const max = Date.parse(rows[rows.length - 1].signup_at);
    const spanDays = (max - min) / 86_400_000;
    // 18 calendar months from 2024-01-01 is 547 days.
    expect(spanDays).toBeGreaterThan(520);
    expect(spanDays).toBeLessThan(560);
  });

  it('segment cardinality is in [5, 8]', () => {
    const distinct = new Set(rows.map((r) => r.segment));
    expect(distinct.size).toBeGreaterThanOrEqual(5);
    expect(distinct.size).toBeLessThanOrEqual(8);
  });
});

describe('fixtures.sql drift guard', () => {
  it('the checked-in seed/fixtures.sql matches what generate.ts re-emits', () => {
    const onDisk = readFileSync(fixturesSqlPath(), 'utf8');
    const reEmitted = emitSql(generateRows());
    expect(onDisk).toBe(reEmitted);
  });

  it('the emitted SQL declares reference_users with every canonical + unmapped column', () => {
    const sql = emitSql(generateRows());
    expect(sql).toContain(`CREATE TABLE "${TABLE_NAME}"`);
    for (const col of [...CANONICAL_FIELDS, ...ATTR_COLUMNS, ...unmappedColumns]) {
      expect(sql).toContain(`"${col}"`);
    }
    // Exactly 5,000 value tuples (each begins `  ('ref-...`).
    expect(sql.match(/\n {2}\('/g) ?? []).toHaveLength(5000);
  });
});
