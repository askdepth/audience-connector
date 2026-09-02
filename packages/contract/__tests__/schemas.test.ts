import { describe, it, expect } from 'vitest';
import { CanonicalFieldSchema } from '../src/fields';
import { QuerySchema } from '../src/criteria';
import { CAPABILITY_FLAGS } from '../src/capabilities';
import {
  HealthResponseSchema,
  SchemaResponseSchema,
  CountRequestSchema,
  CountResponseSchema,
  SearchRequestSchema,
} from '../src/endpoints';

describe('CanonicalFieldSchema (fields.ts)', () => {
  it('accepts a fully populated canonical row', () => {
    const r = CanonicalFieldSchema.safeParse({
      externalId: 'u_1',
      email: 'a@b.com',
      name: 'A',
      segment: 'pro',
      signupAt: '2027-01-01T00:00:00.000Z',
      isActive: true,
      contactable: true,
      attributes: { plan: 'pro', seats: 5 },
    });
    expect(r.success).toBe(true);
  });

  it('accepts the minimal shape (externalId + email only)', () => {
    expect(CanonicalFieldSchema.safeParse({ externalId: 'u_1', email: 'a@b.com' }).success).toBe(
      true,
    );
  });

  it('rejects an empty externalId', () => {
    expect(CanonicalFieldSchema.safeParse({ externalId: '', email: 'a@b.com' }).success).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(CanonicalFieldSchema.safeParse({ externalId: 'u_1', email: 'nope' }).success).toBe(false);
  });

  it('rejects a non-ISO signupAt', () => {
    expect(
      CanonicalFieldSchema.safeParse({ externalId: 'u_1', email: 'a@b.com', signupAt: '2027-01-01' })
        .success,
    ).toBe(false);
  });
});

describe('QuerySchema (criteria.ts) — valid shapes', () => {
  it('segment IN', () => {
    expect(QuerySchema.safeParse({ all: [{ field: 'segment', op: 'in', values: ['pro'] }] }).success).toBe(
      true,
    );
  });

  it('signupAt BETWEEN', () => {
    expect(
      QuerySchema.safeParse({
        all: [
          {
            field: 'signupAt',
            op: 'between',
            from: '2027-01-01T00:00:00.000Z',
            to: '2027-12-31T00:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('isActive EQ', () => {
    expect(
      QuerySchema.safeParse({ all: [{ field: 'isActive', op: 'eq', value: true }] }).success,
    ).toBe(true);
  });

  it('externalId IN', () => {
    expect(
      QuerySchema.safeParse({ all: [{ field: 'externalId', op: 'in', values: ['u_1', 'u_2'] }] })
        .success,
    ).toBe(true);
  });

  it('attr.* EQ', () => {
    expect(
      QuerySchema.safeParse({ all: [{ field: 'attr.plan', op: 'eq', value: 'pro' }] }).success,
    ).toBe(true);
  });

  it('combined criteria with suppressExternalIds and a random sample', () => {
    expect(
      QuerySchema.safeParse({
        all: [
          { field: 'segment', op: 'in', values: ['pro'] },
          { field: 'attr.region', op: 'in', values: ['eu', 'us'] },
        ],
        suppressExternalIds: ['u_9'],
        sample: { method: 'random', size: 200 },
      }).success,
    ).toBe(true);
  });

  it('an empty `all` array (match-all) is structurally valid', () => {
    expect(QuerySchema.safeParse({ all: [] }).success).toBe(true);
  });
});

describe('QuerySchema (criteria.ts) — invalid shapes & boundaries', () => {
  it('rejects segment IN with an empty values array (min 1)', () => {
    expect(QuerySchema.safeParse({ all: [{ field: 'segment', op: 'in', values: [] }] }).success).toBe(
      false,
    );
  });

  it('accepts segment IN with exactly one value (boundary)', () => {
    expect(
      QuerySchema.safeParse({ all: [{ field: 'segment', op: 'in', values: ['x'] }] }).success,
    ).toBe(true);
  });

  it('rejects an unknown field that is neither a DSL literal nor attr.*', () => {
    expect(QuerySchema.safeParse({ all: [{ field: 'plan', op: 'eq', value: 'pro' }] }).success).toBe(
      false,
    );
  });

  it('rejects the wrong op for a known field (segment must be "in")', () => {
    expect(
      QuerySchema.safeParse({ all: [{ field: 'segment', op: 'eq', value: 'pro' }] }).success,
    ).toBe(false);
  });

  it('rejects signupAt BETWEEN with a non-ISO bound', () => {
    expect(
      QuerySchema.safeParse({
        all: [{ field: 'signupAt', op: 'between', from: '2027-01-01', to: '2027-02-01' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a sample size of 0 (must be positive)', () => {
    expect(
      QuerySchema.safeParse({ all: [], sample: { method: 'random', size: 0 } }).success,
    ).toBe(false);
  });
});

describe('capabilities.ts', () => {
  it('exposes exactly the five v1 flags in order', () => {
    expect(CAPABILITY_FLAGS).toEqual([
      'externalIdIn',
      'attributeFilters',
      'dateRanges',
      'randomSample',
      'declaredSchema',
    ]);
  });
});

describe('endpoints.ts', () => {
  it('HealthResponseSchema accepts a valid body with known capability flags', () => {
    expect(
      HealthResponseSchema.safeParse({
        ok: true,
        contractVersion: '1.0.0',
        capabilities: ['externalIdIn', 'randomSample'],
      }).success,
    ).toBe(true);
  });

  it('HealthResponseSchema rejects an unknown capability flag', () => {
    expect(
      HealthResponseSchema.safeParse({
        ok: true,
        contractVersion: '1.0.0',
        capabilities: ['telepathy'],
      }).success,
    ).toBe(false);
  });

  it('SchemaResponseSchema accepts a column list', () => {
    expect(
      SchemaResponseSchema.safeParse({ columns: [{ name: 'user_id', type: 'text' }] }).success,
    ).toBe(true);
  });

  it('CountRequestSchema accepts criteria + a mapping record', () => {
    expect(
      CountRequestSchema.safeParse({
        criteria: { all: [] },
        mapping: { user_id: 'externalId', email_addr: 'email' },
      }).success,
    ).toBe(true);
  });

  it('CountResponseSchema accepts 0 and rejects negatives / non-integers', () => {
    expect(CountResponseSchema.safeParse({ count: 0 }).success).toBe(true);
    expect(CountResponseSchema.safeParse({ count: -1 }).success).toBe(false);
    expect(CountResponseSchema.safeParse({ count: 1.5 }).success).toBe(false);
  });

  it('SearchRequestSchema enforces the 1,000-row hard cap', () => {
    const base = { criteria: { all: [] }, mapping: {} };
    expect(SearchRequestSchema.safeParse({ ...base, limit: 1000 }).success).toBe(true);
    expect(SearchRequestSchema.safeParse({ ...base, limit: 1001 }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ ...base, limit: 0 }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ ...base, limit: 10.5 }).success).toBe(false);
  });

  it('SearchRequestSchema carries an optional cursor', () => {
    expect(
      SearchRequestSchema.safeParse({
        criteria: { all: [] },
        mapping: {},
        limit: 500,
        cursor: 'opaque-cursor-token',
      }).success,
    ).toBe(true);
  });
});
