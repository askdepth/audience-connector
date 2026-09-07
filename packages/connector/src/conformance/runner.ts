// Orchestration for a conformance run. S1 ships an **empty** case registry:
// the goal is only that the CLI connects and honestly reports "0 cases run".
// Case definitions land here in S2+.

import type { ConformanceClient } from './client';

export interface ConformanceCase {
  id: string;
  kind: 'positive' | 'negative';
  run(client: ConformanceClient): Promise<CaseResult>;
}

export interface CaseResult {
  id: string;
  pass: boolean;
  detail?: string;
}

/** The registry. Empty in S1 — do not add a case without a fixture that fails it. */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = Object.freeze([]);

export interface RunSummary {
  url: string;
  cases: CaseResult[];
  passed: number;
  failed: number;
}

export interface RunConformanceOptions {
  /** Echoed into the summary. */
  url: string;
  /** Per-case timeout in ms. */
  timeoutMs: number;
  /** Restrict the run to these case ids (from repeated `--case`). */
  only?: string[];
}

/** A fault in the run itself (bad selection, etc.) — distinct from a case failing. Maps to exit 2. */
export class RunnerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RunnerError';
  }
}

async function runOne(
  testCase: ConformanceCase,
  client: ConformanceClient,
  timeoutMs: number,
): Promise<CaseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const outcome = await Promise.race<CaseResult>([
      testCase.run(client),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error(`case ${testCase.id} timed out after ${timeoutMs}ms`)),
          { once: true },
        );
      }),
    ]);
    return { id: testCase.id, pass: outcome.pass === true, detail: outcome.detail };
  } catch (err) {
    // A throwing case is a failed case, not a runner error.
    return { id: testCase.id, pass: false, detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runConformance(
  client: ConformanceClient,
  cases: readonly ConformanceCase[],
  options: RunConformanceOptions,
): Promise<RunSummary> {
  let selected = [...cases];

  if (options.only && options.only.length > 0) {
    const known = new Set(cases.map((c) => c.id));
    const unknown = options.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new RunnerError(`unknown case id(s): ${unknown.join(', ')}`);
    }
    const wanted = new Set(options.only);
    selected = selected.filter((c) => wanted.has(c.id));
  }

  const results: CaseResult[] = [];
  for (const testCase of selected) {
    // Sequential on purpose: a shared connector must not see a conformance run
    // as a load test, and case output stays deterministic.
    results.push(await runOne(testCase, client, options.timeoutMs));
  }

  const passed = results.filter((r) => r.pass).length;
  return { url: options.url, cases: results, passed, failed: results.length - passed };
}
