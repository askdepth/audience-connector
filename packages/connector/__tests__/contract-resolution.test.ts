import { describe, it, expect } from 'vitest';
import {
  CONTRACT_VERSION,
  CAPABILITY_FLAGS,
  QuerySchema,
  HealthResponseSchema,
  sign,
  verify,
  ROW_CAP as CONTRACT_ROW_CAP,
  DEFAULT_BASE_PATH as CONTRACT_BASE_PATH,
  CONNECTOR_ERROR_CODES,
} from '@askdepth/audience-contract';
import { ROW_CAP as PLAN_ROW_CAP } from '../src/plan';
import { DEFAULT_BASE_PATH as TYPES_BASE_PATH } from '../src/types';
import { ERROR_CODES } from '../src/errors';

// Proves the pnpm workspace wiring resolves `@askdepth/audience-contract`
// from inside `packages/connector` before any connector logic depends on it.
describe('workspace resolution of @askdepth/audience-contract', () => {
  it('resolves the wire-contract version constant', () => {
    expect(CONTRACT_VERSION).toBe('1.0.0');
  });

  it('resolves the capability-flag list', () => {
    expect(CAPABILITY_FLAGS).toContain('externalIdIn');
    expect(CAPABILITY_FLAGS).toContain('declaredSchema');
  });

  it('resolves the runtime zod schemas', () => {
    expect(QuerySchema.safeParse({ all: [] }).success).toBe(true);
    expect(
      HealthResponseSchema.safeParse({
        ok: true,
        contractVersion: CONTRACT_VERSION,
        capabilities: [],
      }).success,
    ).toBe(true);
  });

  it('resolves the signing helpers', () => {
    const secret = Buffer.from('resolution-test-secret', 'utf8');
    const sig = sign('body', 1_700_000_000, secret);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(verify('body', '1700000000', sig, secret, 1_700_000_010).valid).toBe(true);
  });
});

// P4 S-1: three constants the contract now also exports are kept as their own
// literal in the connector (frozen-sensitive files: plan.ts, types.ts,
// errors.ts). These guards fail loudly if the two copies ever drift.
describe('contract constants agree with the connector copies kept as literals', () => {
  it('ROW_CAP: contract === plan.ts', () => {
    expect(CONTRACT_ROW_CAP).toBe(PLAN_ROW_CAP);
    expect(CONTRACT_ROW_CAP).toBe(1000);
  });

  it('DEFAULT_BASE_PATH: contract === types.ts', () => {
    expect(CONTRACT_BASE_PATH).toBe(TYPES_BASE_PATH);
    expect(CONTRACT_BASE_PATH).toBe('/askdepth/v1');
  });

  it('error codes: contract union has the same members as errors.ts ERROR_CODES', () => {
    expect([...CONNECTOR_ERROR_CODES].sort()).toEqual([...ERROR_CODES].sort());
  });
});
