import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SearchResponseSchema } from '../src/endpoints';
import { ErrorResponseSchema } from '../src/errors';
import { ErrorResponseSchema as ErrorResponseSchemaFromBarrel } from '../src/index';

const fx = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8'));

describe('SearchResponseSchema accepts real recorded search responses', () => {
  for (const variant of ['rest', 'postgres'] as const) {
    it(`accepts the ${variant} reference-connector's recorded search response`, () => {
      const body = fx(`search-response.${variant}.json`);
      const parsed = SearchResponseSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      // sanity: it really is a multi-row envelope, not an accidentally-empty one
      const rows = (body as { rows: unknown[] }).rows;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });
  }

  it('rejects a recorded response with rows removed', () => {
    const body = fx('search-response.rest.json') as Record<string, unknown>;
    delete body.rows;
    expect(SearchResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects a recorded response with rows coerced to a non-array', () => {
    const body = fx('search-response.rest.json') as Record<string, unknown>;
    body.rows = 'not-an-array';
    expect(SearchResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('ErrorResponseSchema accepts a real recorded connector error', () => {
  it('accepts the recorded error body', () => {
    const body = fx('error-response.json');
    expect(ErrorResponseSchema.safeParse(body).success).toBe(true);
  });

  it('the recorded error uses a code from the union', () => {
    const parsed = ErrorResponseSchema.safeParse(fx('error-response.json'));
    expect(parsed.success).toBe(true);
  });

  it('is re-exported from the package barrel', () => {
    expect(ErrorResponseSchemaFromBarrel).toBe(ErrorResponseSchema);
  });
});
