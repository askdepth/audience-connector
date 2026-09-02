import { describe, it, expect } from 'vitest';
import {
  CONTRACT_VERSION,
  CAPABILITY_FLAGS,
  QuerySchema,
  HealthResponseSchema,
  sign,
  verify,
} from '@askdepth/audience-contract';

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
