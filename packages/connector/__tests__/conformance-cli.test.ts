import { describe, it, expect, afterEach } from 'vitest';
import { main } from '../src/bin/conformance';
import { startStubConnector, unreachableUrl, type StubConnector } from './_conformance-stub';

const SECRET = 'conformance-cli-secret';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
    out: () => out.join(''),
    err: () => err.join(''),
  };
}

/** No line that looks like a V8 stack frame ("    at ..."). */
function hasStackFrame(s: string): boolean {
  return /\n\s+at\s/.test(s);
}

let stub: StubConnector | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('S1 conformance CLI', () => {
  it('runs a selected case against a reachable connector and reports it', async () => {
    // The stub answers a valid HealthResponse, so the P1 case passes; the
    // point here is CLI plumbing (connect → run → report → exit 0), not the
    // registry being empty (it no longer is).
    stub = await startStubConnector(SECRET);
    const cap = capture();

    const code = await main(
      ['conformance', '--url', stub.url, '--secret', SECRET, '--case', 'P1'],
      cap.io,
    );

    expect(code).toBe(0);
    expect(cap.out()).toContain('P1');
    expect(cap.out()).toContain('1 passed, 0 failed');
    expect(cap.err()).toBe('');
  });

  it('missing --url → exit 2, usage printed, no network call attempted', async () => {
    const cap = capture();
    const code = await main(['conformance', '--secret', SECRET], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('usage');
    expect(cap.err()).toContain('--url');
    expect(cap.err()).not.toMatch(/could not connect|preflight/);
  });

  it('missing --secret → exit 2, usage printed', async () => {
    const cap = capture();
    const code = await main(['--url', 'http://127.0.0.1:1/base'], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('usage');
    expect(cap.err()).toContain('--secret');
  });

  it('malformed --url → exit 2, no stack trace', async () => {
    const cap = capture();
    const code = await main(['--url', 'not-a-url', '--secret', SECRET], cap.io);

    expect(code).toBe(2);
    expect(cap.err()).toContain('not a valid');
    expect(hasStackFrame(cap.err())).toBe(false);
  });

  it('unreachable URL → exit 2 with a connection-refused message, not a stack trace', async () => {
    const cap = capture();
    const dead = await unreachableUrl();
    const code = await main(['--url', `${dead}/base`, '--secret', SECRET], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('connection refused');
    expect(cap.err()).toContain('could not connect to');
    expect(hasStackFrame(cap.err())).toBe(false);
  });

  it('--json emits valid JSON of the fixed shape { url, cases, passed, failed }', async () => {
    stub = await startStubConnector(SECRET);
    const cap = capture();

    const code = await main(
      ['--url', stub.url, '--secret', SECRET, '--json', '--case', 'P1'],
      cap.io,
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out());
    expect(Object.keys(parsed).sort()).toEqual(['cases', 'failed', 'passed', 'url']);
    expect(parsed.url).toBe(stub.url);
    expect(parsed.cases).toEqual([{ id: 'P1', pass: true }]);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(0);
  });

  it('--help → exit 0, prints usage, attempts no network', async () => {
    const cap = capture();
    const code = await main(['--help'], cap.io);

    expect(code).toBe(0);
    expect(cap.out().toLowerCase()).toContain('usage');
    expect(cap.err()).toBe('');
  });

  it('preflight tolerates a connector that answers but rejects the signature', async () => {
    // enforceSignature stub with a DIFFERENT secret: /health comes back 401.
    // That still proves we connected, so this is a normal run whose cases
    // fail (exit 1) — never a runner error (exit 2), and never a connection
    // error on stderr.
    stub = await startStubConnector('a-different-secret');
    const cap = capture();

    const code = await main(['--url', stub.url, '--secret', SECRET], cap.io);

    expect(code).toBe(1);
    expect(cap.err()).not.toMatch(/could not connect|preflight/);
  });

  it('unknown --case id → exit 2 (runner error)', async () => {
    stub = await startStubConnector(SECRET);
    const cap = capture();

    const code = await main(['--url', stub.url, '--secret', SECRET, '--case', 'N1'], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('unknown case');
  });

  it('--timeout-ms with a non-numeric value → exit 2', async () => {
    const cap = capture();
    const code = await main(['--url', 'http://x.local', '--secret', SECRET, '--timeout-ms', 'soon'], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('usage');
  });
});
