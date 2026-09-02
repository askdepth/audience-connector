import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createConnector } from '../src/handler';
import { restAdapter } from '../src/adapters/rest';
import { expressHandler } from '../src/shims/express';
import { fastifyPlugin } from '../src/shims/fastify';
import { lambdaHandler, type LambdaEventV2 } from '../src/shims/lambda';
import { signedHeaders, TEST_SECRET } from './_util';

const NOW = 1_700_000_000;
const PREFIX = '/askdepth/v1';

const connector = createConnector({
  secret: TEST_SECRET,
  adapter: restAdapter({
    fetchCandidates: async () => [],
    fetchCount: async () => 42,
    declaredSchema: { columns: [{ name: 'id', type: 'string' }] },
  }),
  fieldMapping: { externalId: 'id', email: 'mail', segment: 'seg' },
  clock: () => NOW,
});

interface Sent {
  status: number;
  body: string;
}
type Driver = (m: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<Sent>;

// --- bare handler --------------------------------------------------------
const bare: Driver = async ({ method, path, headers, body }) => {
  const req = new Request(`http://bare.test${path}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
  const res = await connector.fetch(req);
  return { status: res.status, body: await res.text() };
};

// --- express (correctly mounted) --------------------------------------------
let expressServer: Server;
let expressPort: number;
let badExpressServer: Server;
let badExpressPort: number;

// --- fastify ------------------------------------------------------------
let fastify: FastifyInstance;

beforeAll(async () => {
  const app = express();
  app.use(express.raw({ type: 'application/json' }));
  app.use(expressHandler(connector));
  await new Promise<void>((resolve) => {
    expressServer = app.listen(0, () => resolve());
  });
  expressPort = (expressServer.address() as AddressInfo).port;

  const badApp = express();
  badApp.use(express.json()); // the footgun
  badApp.use(expressHandler(connector));
  await new Promise<void>((resolve) => {
    badExpressServer = badApp.listen(0, () => resolve());
  });
  badExpressPort = (badExpressServer.address() as AddressInfo).port;

  fastify = Fastify();
  await fastify.register(fastifyPlugin(connector));
  await fastify.ready();
});

afterAll(async () => {
  await new Promise<void>((r) => expressServer.close(() => r()));
  await new Promise<void>((r) => badExpressServer.close(() => r()));
  await fastify.close();
});

const viaExpress =
  (port: () => number): Driver =>
  async ({ method, path, headers, body }) => {
    const res = await fetch(`http://127.0.0.1:${port()}${path}`, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });
    return { status: res.status, body: await res.text() };
  };

const viaFastify: Driver = async ({ method, path, headers, body }) => {
  const res = await fastify.inject({
    method: method as 'GET' | 'POST',
    url: path,
    headers,
    payload: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
  return { status: res.statusCode, body: res.body };
};

const viaLambda =
  (base64 = false): Driver =>
  async ({ method, path, headers, body }) => {
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const event: LambdaEventV2 = {
      rawPath: path.split('?')[0],
      rawQueryString: path.includes('?') ? path.split('?')[1] : '',
      headers: { ...headers, host: 'lambda.test' },
      body: hasBody ? (base64 ? Buffer.from(body, 'utf8').toString('base64') : body) : null,
      isBase64Encoded: hasBody ? base64 : false,
      requestContext: { http: { method }, domainName: 'lambda.test' },
    };
    const res = await lambdaHandler(connector)(event);
    return { status: res.statusCode, body: res.body };
  };

/** Sign a POST body and produce {headers, body}. */
function signedPost(path: string, bodyStr: string) {
  const headers: Record<string, string> = {};
  signedHeaders({ method: 'POST', body: bodyStr, timestamp: NOW }).forEach((v, k) => {
    headers[k] = v;
  });
  return { method: 'POST', path: `${PREFIX}${path}`, headers, body: bodyStr };
}

const goodDrivers: Array<[string, Driver]> = [
  ['bare', bare],
  ['express', viaExpress(() => expressPort)],
  ['fastify', viaFastify],
  ['lambda', viaLambda(false)],
];

describe('S8.1 — a signed request behaves identically through every shim', () => {
  const body = JSON.stringify({ criteria: { all: [] }, mapping: {} });
  it('same status and body as the bare handler', async () => {
    const reference = await bare(signedPost('/candidates/count', body));
    expect(reference.status).toBe(200);
    expect(JSON.parse(reference.body)).toEqual({ count: 42 });
    for (const [name, drive] of goodDrivers) {
      const got = await drive(signedPost('/candidates/count', body));
      expect(got.status, name).toBe(reference.status);
      expect(JSON.parse(got.body), name).toEqual(JSON.parse(reference.body));
    }
  });
});

describe('S8.2 — a non-ASCII body verifies through every shim', () => {
  const body = JSON.stringify({
    criteria: { all: [{ field: 'segment', op: 'in', values: ['café', '日本'] }] },
    mapping: {},
  });
  for (const [name, drive] of goodDrivers) {
    it(name, async () => {
      const got = await drive(signedPost('/candidates/count', body));
      expect(got.status).toBe(200);
    });
  }
});

describe('S8.3 — the raw bytes are used, not a re-encode', () => {
  // keys in an order a JSON re-serialiser would not produce
  const body = '{"mapping":{},"criteria":{"all":[]}}';
  for (const [name, drive] of goodDrivers) {
    it(name, async () => {
      const got = await drive(signedPost('/candidates/count', body));
      expect(got.status).toBe(200);
    });
  }
});

describe('S8.4 — Express mounted after express.json() fails loudly', () => {
  it('names the cause and does not produce a 401', async () => {
    const body = JSON.stringify({ criteria: { all: [] }, mapping: {} });
    const got = await viaExpress(() => badExpressPort)(signedPost('/candidates/count', body));
    expect(got.status).not.toBe(401);
    expect(got.status).toBe(500);
    expect(got.body.toLowerCase()).toMatch(/express\.raw|already parsed|raw bytes/);
  });
});

describe('S8.5 — Lambda with isBase64Encoded verifies', () => {
  it('base64-encoded body', async () => {
    const body = JSON.stringify({ criteria: { all: [] }, mapping: {} });
    const got = await viaLambda(true)(signedPost('/candidates/count', body));
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body)).toEqual({ count: 42 });
  });
});

describe('S8.6 — error statuses are preserved, not swallowed', () => {
  for (const [name, drive] of goodDrivers) {
    it(`${name}: unsigned → 401`, async () => {
      const got = await drive({
        method: 'POST',
        path: `${PREFIX}/candidates/count`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ criteria: { all: [] }, mapping: {} }),
      });
      expect(got.status).toBe(401);
    });
    it(`${name}: signed unknown path → 404`, async () => {
      const headers: Record<string, string> = {};
      signedHeaders({ method: 'GET', body: '', timestamp: NOW }).forEach((v, k) => {
        headers[k] = v;
      });
      const got = await drive({ method: 'GET', path: `${PREFIX}/nope`, headers, body: '' });
      expect(got.status).toBe(404);
    });
  }
});

describe('S8.7 — a large but legal body passes through every shim', () => {
  const body = JSON.stringify({
    criteria: {
      all: [],
      suppressExternalIds: Array.from({ length: 1_000 }, (_, i) => `u_${i}`),
    },
    mapping: {},
  });
  for (const [name, drive] of goodDrivers) {
    it(name, async () => {
      const got = await drive(signedPost('/candidates/count', body));
      expect(got.status).toBe(200);
    });
  }
});
