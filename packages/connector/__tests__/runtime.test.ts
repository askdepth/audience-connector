import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { HealthResponseSchema } from '@askdepth/audience-contract';
import { signedHeaders, TEST_SECRET } from './_util';

// The examples import the package by its public name; vitest.config.ts aliases
// that to local source. `examples/smoke.mjs` covers the built dist on
// Node/Deno/Bun in CI; `examples/worker/` covers workerd.
import { GET as NEXT_GET, POST as NEXT_POST } from '../../../examples/nextjs-route/app/askdepth/[[...route]]/route';
import { audienceConnector } from '../../../examples/cloud-function-gen2/index';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

// The examples hard-code this secret as their env fallback and use the real
// wall clock (no test seam), so sign with a current timestamp.
const EXAMPLE_SECRET = 'example-secret-do-not-ship';

function headers(method: 'GET' | 'POST', body = ''): Record<string, string> {
  const h: Record<string, string> = {};
  signedHeaders({ method, body, secret: EXAMPLE_SECRET }).forEach((v, k) => {
    h[k] = v;
  });
  return h;
}

describe('S9 — Next.js route handler example runs unmodified', () => {
  it('a signed GET /health returns a valid HealthResponse', async () => {
    const req = new Request('https://next.example/askdepth/v1/health', {
      method: 'GET',
      headers: headers('GET'),
    });
    const res = await NEXT_GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(HealthResponseSchema.safeParse(body).success).toBe(true);
    expect(body.ok).toBe(true);
  });

  it('a signed POST /candidates/count returns a count', async () => {
    const payload = JSON.stringify({ criteria: { all: [] }, mapping: {} });
    const req = new Request('https://next.example/askdepth/v1/candidates/count', {
      method: 'POST',
      headers: headers('POST', payload),
      body: payload,
    });
    const res = await NEXT_POST(req);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).count).toBe(0);
  });

  it('an unsigned request is refused', async () => {
    const res = await NEXT_GET(new Request('https://next.example/askdepth/v1/health'));
    expect(res.status).toBe(401);
  });
});

describe('S9 — Cloud Functions gen2 example runs unmodified', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.use(express.raw({ type: 'application/json' }));
    app.use(audienceConnector);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('a signed request through the Functions Framework shape succeeds', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/askdepth/v1/health`, {
      method: 'GET',
      headers: headers('GET'),
    });
    expect(res.status).toBe(200);
    expect(HealthResponseSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('an unsigned request is refused (401, not swallowed)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/askdepth/v1/health`);
    expect(res.status).toBe(401);
  });
});

describe('S9 — the runtime matrix cannot drift from the README', () => {
  const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
  const matrix = readFileSync(resolve(REPO_ROOT, 'docs', 'runtime-support.md'), 'utf8');

  // Runtimes the README names in its "## Runtimes" section.
  const runtimesSection = readme.split('## Runtimes')[1] ?? '';
  const NAMES = ['Node.js', 'Next.js', 'Google Cloud Functions gen2', 'Deno', 'Bun', 'Cloudflare Workers'];

  it('every runtime the README names appears in docs/runtime-support.md', () => {
    for (const name of NAMES) {
      if (runtimesSection.includes(name)) {
        expect(matrix, `${name} missing from runtime-support.md`).toContain(name);
      }
    }
  });

  it('runtime-support.md has no "should work" / "probably" hedging', () => {
    expect(matrix.toLowerCase()).not.toMatch(/should work|probably works|likely works/);
  });

  it('every matrix row is either verified or not supported', () => {
    const rows = matrix
      .split('\n')
      .filter((l) => l.startsWith('| **') && !l.includes('---'));
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(row === '' || /✅ verified|not supported/.test(row), row).toBe(true);
    }
  });
});
