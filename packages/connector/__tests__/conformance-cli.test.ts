import { describe, it, expect, afterEach } from 'vitest';
import { main, parseArgs } from '../src/bin/conformance';
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
    // The reported URL is run through redactUrl (strip any credentials), which
    // normalises via `new URL(...).toString()` — hence the trailing slash on a
    // bare-origin URL. No credentials here, so it is otherwise unchanged.
    expect(parsed.url).toBe(new URL(stub.url).toString());
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

    // `ZZ9` is in no stage's registry (N1/N2/N4/N8 are, as of S3).
    const code = await main(['--url', stub.url, '--secret', SECRET, '--case', 'ZZ9'], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('unknown case');
    expect(cap.err()).toContain('ZZ9');
  });

  it('--timeout-ms with a non-numeric value → exit 2', async () => {
    const cap = capture();
    const code = await main(['--url', 'http://x.local', '--secret', SECRET, '--timeout-ms', 'soon'], cap.io);

    expect(code).toBe(2);
    expect(cap.err().toLowerCase()).toContain('usage');
  });

  describe('secret from the environment', () => {
    const saved = {
      secret: process.env.ASKDEPTH_SECRET,
      previous: process.env.ASKDEPTH_PREVIOUS_SECRET,
    };
    afterEach(() => {
      if (saved.secret === undefined) delete process.env.ASKDEPTH_SECRET;
      else process.env.ASKDEPTH_SECRET = saved.secret;
      if (saved.previous === undefined) delete process.env.ASKDEPTH_PREVIOUS_SECRET;
      else process.env.ASKDEPTH_PREVIOUS_SECRET = saved.previous;
    });

    it('no --secret but ASKDEPTH_SECRET set → parses, env value used', () => {
      delete process.env.ASKDEPTH_PREVIOUS_SECRET;
      process.env.ASKDEPTH_SECRET = 'from-env-secret';
      const parsed = parseArgs(['--url', 'https://c.example/askdepth/v1']);
      if ('help' in parsed) throw new Error('unreachable');
      expect(parsed.secret).toBe('from-env-secret');
    });

    it('--secret on argv still wins over ASKDEPTH_SECRET', () => {
      process.env.ASKDEPTH_SECRET = 'from-env-secret';
      const parsed = parseArgs(['--url', 'https://c.example/askdepth/v1', '--secret', 'from-argv']);
      if ('help' in parsed) throw new Error('unreachable');
      expect(parsed.secret).toBe('from-argv');
    });

    it('ASKDEPTH_PREVIOUS_SECRET feeds --previous-secret', () => {
      process.env.ASKDEPTH_SECRET = 'from-env-secret';
      process.env.ASKDEPTH_PREVIOUS_SECRET = 'old-env-secret';
      const parsed = parseArgs(['--url', 'https://c.example/askdepth/v1']);
      if ('help' in parsed) throw new Error('unreachable');
      expect(parsed.previousSecret).toBe('old-env-secret');
    });

    it('neither --secret nor ASKDEPTH_SECRET → exit 2, message names both', async () => {
      delete process.env.ASKDEPTH_SECRET;
      const cap = capture();
      const code = await main(['--url', 'http://127.0.0.1:1/base'], cap.io);

      expect(code).toBe(2);
      expect(cap.err()).toContain('--secret');
      expect(cap.err()).toContain('ASKDEPTH_SECRET');
    });
  });

  describe('URL credential redaction', () => {
    it('unreachable URL with credentials → stderr leaks neither user nor password', async () => {
      const cap = capture();
      const code = await main(
        ['--url', 'https://user:s3cr3t@127.0.0.1:9/x', '--secret', SECRET],
        cap.io,
      );

      expect(code).toBe(2);
      expect(cap.err()).not.toMatch(/user|s3cr3t/);
    });

    it('the summary url echoed into --json output is run through redactUrl', async () => {
      // `fetch` refuses a URL that embeds credentials outright, so the credential
      // case can never reach a summary; this asserts the redactUrl wiring on the
      // path that does — the reported url is the normalised (round-tripped) form.
      stub = await startStubConnector(SECRET);
      const cap = capture();

      const code = await main(['--url', stub.url, '--secret', SECRET, '--json', '--case', 'P1'], cap.io);

      expect(code).toBe(0);
      const parsed = JSON.parse(cap.out());
      expect(parsed.url).toBe(new URL(stub.url).toString());
    });

    it('a credentialed --url with --json leaks the secret on neither stream', async () => {
      const cap = capture();
      const code = await main(
        ['--url', 'https://user:s3cr3t@127.0.0.1:9/x', '--secret', SECRET, '--json'],
        cap.io,
      );

      expect(code).toBe(2);
      expect(cap.out()).not.toMatch(/user|s3cr3t/);
      expect(cap.err()).not.toMatch(/user|s3cr3t/);
    });
  });

  describe('--filter-only-attribute name/value parsing', () => {
    it('bare <name> goes to the list only (backward compatible)', () => {
      const parsed = parseArgs([
        '--url', 'https://c.example/askdepth/v1',
        '--secret', 's',
        '--filter-only-attribute', 'country',
      ]);
      if ('help' in parsed) throw new Error('unreachable');
      expect(parsed.filterOnlyAttributes).toEqual(['country']);
      expect(parsed.filterOnlyAttributeValues).toEqual({});
    });

    it('<name>=<value> records the value AND keeps the name in the list', () => {
      const parsed = parseArgs([
        '--url', 'https://c.example/askdepth/v1',
        '--secret', 's',
        '--filter-only-attribute', 'country=US',
      ]);
      if ('help' in parsed) throw new Error('unreachable');
      expect(parsed.filterOnlyAttributes).toEqual(['country']);
      expect(parsed.filterOnlyAttributeValues).toEqual({ country: 'US' });
    });

    it('repetition mixes both forms; --flag=name=value also works', () => {
      const parsed = parseArgs([
        '--url', 'https://c.example/askdepth/v1',
        '--secret', 's',
        '--filter-only-attribute', 'country=US',
        '--filter-only-attribute', 'region',
        '--filter-only-attribute=tier=gold',
      ]);
      if ('help' in parsed) throw new Error('unreachable');
      expect(parsed.filterOnlyAttributes).toEqual(['country', 'region', 'tier']);
      expect(parsed.filterOnlyAttributeValues).toEqual({ country: 'US', tier: 'gold' });
    });
  });
});
