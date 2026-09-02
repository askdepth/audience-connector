import { describe, it, expect } from 'vitest';
import {
  ConnectorError,
  ERROR_CODES,
  httpStatusFor,
  wireMessageFor,
  toResponse,
  redact,
  type ConnectorErrorCode,
} from '../src/errors';

const EXPECTED_STATUS: Record<ConnectorErrorCode, number> = {
  unauthorized: 401,
  invalid_signature: 401,
  expired_timestamp: 401,
  malformed_request: 400,
  unsupported_capability: 400,
  limit_exceeded: 400,
  invalid_cursor: 400,
  not_found: 404,
  method_not_allowed: 405,
  adapter_error: 502,
  timeout: 504,
  internal: 500,
};

async function bodyOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe('S2.1 — every code maps to its documented HTTP status', () => {
  it('covers exactly the closed code set', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(EXPECTED_STATUS).sort());
  });

  for (const [code, status] of Object.entries(EXPECTED_STATUS)) {
    it(`${code} → ${status}`, async () => {
      expect(httpStatusFor(code as ConnectorErrorCode)).toBe(status);
      const res = toResponse(new ConnectorError(code as ConnectorErrorCode));
      expect(res.status).toBe(status);
      expect((await bodyOf(res) as { error: { code: string } }).error.code).toBe(code);
    });
  }
});

describe('S2.2 — serialised body is exactly { error: { code, message } }', () => {
  it('has no keys beyond error.code and error.message', async () => {
    const res = toResponse(new ConnectorError('malformed_request'));
    const body = await bodyOf(res) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error as object).sort()).toEqual(['code', 'message']);
    expect(body).toEqual({
      error: { code: 'malformed_request', message: wireMessageFor('malformed_request') },
    });
  });

  it('sets Content-Type: application/json on the error response', () => {
    const res = toResponse(new ConnectorError('internal'));
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('S2.3 — detail never reaches the wire', () => {
  it('a DSN, an email and a row object in detail appear nowhere in the body', async () => {
    const dsn = 'postgres://u:p@h/db';
    const email = 'alice@example.com';
    const row = { externalId: 'u_42', email, name: 'Alice', ssn: '000-00-0000' };
    const res = toResponse(new ConnectorError('adapter_error', { dsn, email, row }));
    const text = await res.text();
    for (const needle of [dsn, email, 'u_42', 'Alice', '000-00-0000', 'ssn']) {
      expect(text).not.toContain(needle);
    }
    expect(JSON.parse(text)).toEqual({
      error: { code: 'adapter_error', message: wireMessageFor('adapter_error') },
    });
  });
});

describe('S2.4 — a raw driver Error is coerced and scrubbed', () => {
  it('non-ConnectorError → internal, message discarded', async () => {
    const raw = new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2');
    const res = toResponse(raw);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('10.0.0.4');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal', message: wireMessageFor('internal') },
    });
  });

  it('the same raw Error wrapped as adapter_error still leaks nothing', async () => {
    // This is how S4/S6 surface an adapter failure: wrap, never rethrow raw.
    const raw = new Error('connect ECONNREFUSED 10.0.0.4:5432 password=hunter2');
    const res = toResponse(new ConnectorError('adapter_error', raw));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('10.0.0.4');
    expect(text).not.toContain('hunter2');
    expect(text).toContain(wireMessageFor('adapter_error'));
  });
});

describe('S2.5 — fuzz: a random token embedded in detail never appears in a body', () => {
  const codes = [...ERROR_CODES];
  it('100 generated errors leak no token', async () => {
    for (let i = 0; i < 100; i++) {
      const token = Array.from({ length: 20 }, () =>
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[
          Math.floor(Math.random() * 62)
        ],
      ).join('');
      const code = codes[i % codes.length];
      const detail = {
        token,
        nested: { token, arr: [token, `prefix-${token}-suffix`] },
        message: `boom ${token}`,
      };
      const res = toResponse(new ConnectorError(code, detail));
      const text = await res.text();
      expect(text, `code=${code} token=${token}`).not.toContain(token);
    }
  });
});

describe('S2.6 — redact()', () => {
  it('masks a DSN', () => {
    expect(redact('db url is postgres://user:s3cr3t@10.0.0.4:5432/prod now')).toBe(
      'db url is [redacted-connection-string] now',
    );
  });

  it('masks an Authorization: Bearer header value', () => {
    const out = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.abc.def');
    expect(out).toContain('[redacted]');
  });

  it('masks a secret= / password= pair but keeps the key name', () => {
    expect(redact('password=hunter2 secret: "topsecret"')).toBe(
      'password=[redacted] secret: "[redacted]"',
    );
  });

  it('leaves unrelated text intact', () => {
    const plain = 'The quick brown fox jumps over the lazy dog. count=42 status=ok';
    expect(redact(plain)).toBe(plain);
  });
});
