// Orchestration for a conformance run. S1 shipped an empty registry; S2 wired
// the seven **positive** cases from `docs/conformance-spec.md` ("a connector
// must pass, to activate"). S3 added the four **negative** cases that are
// provable purely from the wire, with no data fixture — N1, N2, N4, N8 of the
// "a connector fails if it…" list. S4 adds the four that need a seeded, known
// data set to detect: N3 (unmapped columns), N5 (non-deterministic cursor
// pagination), N6 (the 1,000-row cap), N7 (a non-random subsample while
// advertising `randomSample`). The registry is now the full 15.

import type { ConformanceClient } from './client';
import { healthCase } from './cases/positive/health';
import { schemaCase } from './cases/positive/schema';
import { countCase } from './cases/positive/count';
import { searchCase } from './cases/positive/search';
import { externalIdInCase } from './cases/positive/external-id-in';
import { attributeFiltersCase } from './cases/positive/attribute-filters';
import { suppressExternalIdsCase } from './cases/positive/suppress-external-ids';
import { unsignedAcceptedCase } from './cases/negative/unsigned-accepted';
import { badSignatureAcceptedCase } from './cases/negative/bad-signature-accepted';
import { unmappedColumnsLeakedCase } from './cases/negative/unmapped-columns-leaked';
import { errorLeaksDataCase } from './cases/negative/error-leaks-data';
import { cursorNondeterministicCase } from './cases/negative/cursor-nondeterministic';
import { rowCapExceededCase } from './cases/negative/row-cap-exceeded';
import { sampleNotRandomCase } from './cases/negative/sample-not-random';
import { writePathExposedCase } from './cases/negative/write-path-exposed';

/**
 * Out-of-band knowledge a case may need that cannot be learned from the wire.
 * Threaded from the CLI (`--unmapped-column`) through {@link runConformance}
 * into every case. Cases that need nothing from it simply ignore the argument.
 */
export interface ConformanceCaseContext {
  /**
   * Store columns the operator has declared exist in the backing data but are
   * intentionally not in `fieldMapping` — and, being sensitive, must appear in
   * no **candidate-data** response (`/candidates/search` row payloads and
   * `/candidates/count` bodies). Consumed by N3. `/schema` is not graded
   * against this list — a connector legitimately introspects the whole store.
   * Empty when the operator supplied no `--unmapped-column`.
   */
  readonly unmappedColumns: readonly string[];
}

/** The context a case sees when the runner is given none (direct unit calls). */
export const EMPTY_CASE_CONTEXT: ConformanceCaseContext = Object.freeze({
  unmappedColumns: Object.freeze([]) as readonly string[],
});

export interface ConformanceCase {
  id: string;
  kind: 'positive' | 'negative';
  run(client: ConformanceClient, context?: ConformanceCaseContext): Promise<CaseResult>;
}

export interface CaseResult {
  id: string;
  pass: boolean;
  detail?: string;
}

/**
 * The registry, in `docs/conformance-spec.md` order: the positive list first
 * (P1–P7), then the negative list in full (N1–N8). Every case has both a
 * "correct connector passes" and a "deliberately-broken fixture fails" test —
 * positives in `__tests__/conformance-positive.test.ts`, wire-only negatives
 * in `__tests__/conformance-negative.test.ts`, and the seeded-data negatives
 * (N3/N5/N6/N7) in `__tests__/conformance-negative-data.test.ts`.
 */
export const CONFORMANCE_CASES: readonly ConformanceCase[] = Object.freeze([
  healthCase,
  schemaCase,
  countCase,
  searchCase,
  externalIdInCase,
  attributeFiltersCase,
  suppressExternalIdsCase,
  unsignedAcceptedCase,
  badSignatureAcceptedCase,
  unmappedColumnsLeakedCase,
  errorLeaksDataCase,
  cursorNondeterministicCase,
  rowCapExceededCase,
  sampleNotRandomCase,
  writePathExposedCase,
]);

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
  /** Out-of-band knowledge for the cases. Defaults to {@link EMPTY_CASE_CONTEXT}. */
  context?: ConformanceCaseContext;
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
  context: ConformanceCaseContext,
): Promise<CaseResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const outcome = await Promise.race<CaseResult>([
      testCase.run(client, context),
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

  const context = options.context ?? EMPTY_CASE_CONTEXT;

  const results: CaseResult[] = [];
  for (const testCase of selected) {
    // Sequential on purpose: a shared connector must not see a conformance run
    // as a load test, and case output stays deterministic.
    results.push(await runOne(testCase, client, options.timeoutMs, context));
  }

  const passed = results.filter((r) => r.pass).length;
  return { url: options.url, cases: results, passed, failed: results.length - passed };
}
