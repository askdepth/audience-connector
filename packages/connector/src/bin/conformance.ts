// CLI entrypoint for `audience-connector conformance`.
//
// S1 scope: parse args, build a signed client, prove the connector is
// reachable (a signed GET /health preflight), run the — currently empty —
// case registry, and report. No case logic yet.
//
// Exit codes:
//   0  every case passed (an empty registry is a pass)
//   1  at least one conformance case failed
//   2  runner error: missing/invalid arg, malformed URL, unreachable connector

import { createConformanceClient, ConnectionError } from '../conformance/client';
import { CONFORMANCE_CASES, RunnerError, runConformance } from '../conformance/runner';
import { renderHuman, renderJson } from '../conformance/report';

const USAGE = `Usage: audience-connector conformance --url <url> --secret <secret> [options]

Runs the Askdepth Audience SDK conformance suite against a deployed connector.

Required:
  --url <url>              Base URL of the connector (http/https)
  --secret <secret>        Active signing secret

Options:
  --previous-secret <s>    Previous signing secret (rotation overlap)
  --case <id>              Run only this case id (repeatable)
  --unmapped-column <name> A store column that exists but is intentionally not
                           mapped, and must appear in no response (repeatable).
                           Used by case N3.
  --filter-only-attribute <name>
                           An attribute usable in attr.* criteria but never
                           projected into a row payload (not returnable).
                           Used by case P6 (repeatable).
  --json                   Emit machine-readable JSON instead of a table
  --timeout-ms <n>         Per-case timeout in milliseconds (default 5000)
  -h, --help               Show this help

Exit codes: 0 all passed | 1 a case failed | 2 runner error`;

interface ParsedArgs {
  url: string;
  secret: string;
  previousSecret?: string;
  cases: string[];
  unmappedColumns: string[];
  filterOnlyAttributes: string[];
  json: boolean;
  timeoutMs: number;
}

class UsageError extends Error {}

export function parseArgs(argv: string[]): ParsedArgs | { help: true } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };

  let url: string | undefined;
  let secret: string | undefined;
  let previousSecret: string | undefined;
  const cases: string[] = [];
  const unmappedColumns: string[] = [];
  const filterOnlyAttributes: string[] = [];
  let json = false;
  let timeoutMs = 5000;

  const valueAfter = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`error: ${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    let flag = token;
    let inline: string | undefined;
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      flag = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }

    switch (flag) {
      case 'conformance':
        // Optional leading subcommand — accepted so the documented
        // `audience-connector conformance ...` invocation works.
        if (i !== 0) throw new UsageError(`error: unexpected argument "${token}"`);
        break;
      case '--url':
        url = inline ?? valueAfter(i, '--url');
        if (inline === undefined) i++;
        break;
      case '--secret':
        secret = inline ?? valueAfter(i, '--secret');
        if (inline === undefined) i++;
        break;
      case '--previous-secret':
        previousSecret = inline ?? valueAfter(i, '--previous-secret');
        if (inline === undefined) i++;
        break;
      case '--case':
        cases.push(inline ?? valueAfter(i, '--case'));
        if (inline === undefined) i++;
        break;
      case '--unmapped-column':
        unmappedColumns.push(inline ?? valueAfter(i, '--unmapped-column'));
        if (inline === undefined) i++;
        break;
      case '--filter-only-attribute':
        filterOnlyAttributes.push(inline ?? valueAfter(i, '--filter-only-attribute'));
        if (inline === undefined) i++;
        break;
      case '--timeout-ms': {
        const raw = inline ?? valueAfter(i, '--timeout-ms');
        if (inline === undefined) i++;
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) {
          throw new UsageError('error: --timeout-ms must be a positive number');
        }
        timeoutMs = n;
        break;
      }
      case '--json':
        json = true;
        break;
      default:
        throw new UsageError(`error: unknown argument "${token}"`);
    }
  }

  if (!url) throw new UsageError('error: --url is required');
  if (!secret) throw new UsageError('error: --secret is required');
  return { url, secret, previousSecret, cases, unmappedColumns, filterOnlyAttributes, json, timeoutMs };
}

function describeConnectionError(err: ConnectionError): string {
  const chain: unknown[] = [];
  let cur: unknown = err.cause;
  for (let i = 0; i < 5 && cur; i++) {
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  const codes = chain.map((c) => (c as { code?: string }).code).filter(Boolean);
  const names = chain.map((c) => (c as { name?: string }).name).filter(Boolean);
  if (codes.includes('ECONNREFUSED')) return 'connection refused';
  if (codes.includes('ENOTFOUND') || codes.includes('EAI_AGAIN')) return 'host not found';
  if (names.includes('TimeoutError') || names.includes('AbortError')) return 'connection timed out';
  if (codes.length > 0) return String(codes[0]);
  const msg = (chain[chain.length - 1] as { message?: string })?.message;
  return msg ? msg : 'unreachable';
}

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIO: CliIO = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  let parsed: ParsedArgs | { help: true };
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}\n`);
    return 2;
  }

  if ('help' in parsed) {
    io.out(`${USAGE}\n`);
    return 0;
  }

  // Validate the URL before any network call.
  try {
    const u = new URL(parsed.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('protocol must be http or https');
    }
  } catch {
    io.err(`error: --url is not a valid http(s) URL: ${parsed.url}\n`);
    return 2;
  }

  const client = createConformanceClient({
    url: parsed.url,
    secret: parsed.secret,
    previousSecret: parsed.previousSecret,
    timeoutMs: parsed.timeoutMs,
  });

  // Preflight: a signed GET /health. Any HTTP response (even 401/500) proves
  // we connected; only a transport failure is a runner error.
  try {
    await client.get('/health');
  } catch (err) {
    if (err instanceof ConnectionError) {
      io.err(`error: could not connect to ${parsed.url}: ${describeConnectionError(err)}\n`);
      return 2;
    }
    io.err(`error: preflight failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  let summary;
  try {
    summary = await runConformance(client, CONFORMANCE_CASES, {
      url: parsed.url,
      timeoutMs: parsed.timeoutMs,
      only: parsed.cases,
      context: {
        unmappedColumns: parsed.unmappedColumns,
        filterOnlyAttributes: parsed.filterOnlyAttributes,
      },
    });
  } catch (err) {
    if (err instanceof RunnerError) {
      io.err(`error: ${err.message}\n`);
      return 2;
    }
    io.err(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  io.out(`${parsed.json ? renderJson(summary) : renderHuman(summary)}\n`);
  return summary.failed > 0 ? 1 : 0;
}

// Run only when executed directly (`node dist/bin/conformance.js`), not when a
// test imports `main`. The shipped bin is a CommonJS bundle, so `require.main
// === module` is the reliable check there; when this file is loaded as ESM
// (the vitest run) those globals are absent and the block is skipped.
declare const module: unknown;
if (
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  (require as { main?: unknown }).main === module
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(2);
    },
  );
}
