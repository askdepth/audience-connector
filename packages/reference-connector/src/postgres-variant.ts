// The Askdepth reference connector — Postgres variant (spec §S7).
//
// A genuine, deployable connector instance. It consumes the **built public**
// `@askdepth/audience-connector` package exactly as a client integrator would:
//   * `createConnector` + `postgresAdapter` from the package root entry
//     (the package's `exports` map puts both on `.`);
//   * `expressHandler` from the `/express` subpath export;
// and mounts the result over the S6 seeded synthetic user base
// (`reference_users`, 5,000 rows) living in a real Postgres.
//
// No reach-in: nothing here imports `@askdepth/audience-connector/src/*` or any
// internal module, and there is no code path that exists only to satisfy the
// platform's integration tests.
//
// ── Environment ───────────────────────────────────────────────────────────
//   REFERENCE_SECRET   required — HMAC signing secret. No insecure default:
//                      the process refuses to start without it.
//   DATABASE_URL       Postgres connection string. `TEST_DATABASE_URL` is
//                      accepted as a fallback so CI / local test runs that
//                      already export it need no extra wiring.
//   PORT               listen port (default 8787).
//
// ── Run ───────────────────────────────────────────────────────────────────
//   REFERENCE_SECRET=… DATABASE_URL=… pnpm --filter @askdepth/reference-connector start:postgres
// prints `listening on :<port>` once the HTTP listener is up.

import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { createConnector, postgresAdapter } from '@askdepth/audience-connector';
import { expressHandler } from '@askdepth/audience-connector/express';
import { fieldMapping, attributes, TABLE_NAME } from '../seed/generate';

/** Handle returned by {@link start}. */
export interface StartedVariant {
  /** Base URL including the connector route prefix — ready for the conformance CLI. */
  readonly url: string;
  /** The port actually bound (useful when `port: 0` asks for an ephemeral one). */
  readonly port: number;
  /** The signing secret in force — echoed so a demo/test need not re-read env. */
  readonly secret: string;
  /** Stop the HTTP listener and drain the Postgres pool. */
  close(): Promise<void>;
}

export interface StartOptions {
  /** Override the listen port. `0` binds an ephemeral port. Defaults to `PORT` env or 8787. */
  port?: number;
}

function requiredSecret(): string {
  const secret = process.env.REFERENCE_SECRET;
  if (!secret || secret.trim() === '') {
    throw new Error(
      'reference-connector (postgres): REFERENCE_SECRET is required and has no insecure default — ' +
        'export REFERENCE_SECRET before starting the variant.',
    );
  }
  return secret;
}

function connectionString(): string {
  const dsn = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!dsn || dsn.trim() === '') {
    throw new Error(
      'reference-connector (postgres): set DATABASE_URL (or TEST_DATABASE_URL) to a Postgres ' +
        'connection string for the seeded reference_users database.',
    );
  }
  return dsn;
}

/**
 * Boot the variant. Resolves once the HTTP listener is accepting connections.
 * The caller owns the returned {@link StartedVariant} and must `close()` it.
 */
export async function start(opts: StartOptions = {}): Promise<StartedVariant> {
  const secret = requiredSecret();
  const dsn = connectionString();
  const port = opts.port ?? Number(process.env.PORT ?? 8787);

  const pool = new Pool({ connectionString: dsn });

  // Consumed as a third-party integrator would: the real adapter, the real
  // factory, the S6 canonical mapping + attribute config. `country` is
  // filter-only (absent from `returnable`) by construction.
  const connector = createConnector({
    adapter: postgresAdapter({ pool, table: TABLE_NAME }),
    fieldMapping: { ...fieldMapping },
    attributes: {
      filterable: [...attributes.filterable],
      returnable: [...attributes.returnable],
    },
    secret,
  });

  const app = express();
  // No body parser on purpose: the Express shim needs the exact signed bytes
  // for signature verification. `express.json()` would discard them.
  app.use(expressHandler(connector));

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.once('error', reject);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const url = `http://localhost:${boundPort}/askdepth/v1`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await pool.end();
  };

  return { url, port: boundPort, secret, close };
}

function isMain(): boolean {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
}

if (isMain()) {
  start().then(
    (variant) => {
      // The exact line CI (and the demo script) waits for.
      // eslint-disable-next-line no-console
      console.log(`listening on :${variant.port}`);
      // eslint-disable-next-line no-console
      console.log(`conformance url: ${variant.url}`);
    },
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
