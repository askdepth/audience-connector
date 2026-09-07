// Rendering for a {@link RunSummary}: a human PASS/FAIL table, and a stable
// `--json` shape.

import type { RunSummary } from './runner';

/**
 * The `--json` payload. Shape is fixed: `{ url, cases, passed, failed }`.
 * `cases` entries are `CaseResult` objects (`{ id, pass, detail? }`).
 */
export function renderJson(summary: RunSummary): string {
  return JSON.stringify({
    url: summary.url,
    cases: summary.cases,
    passed: summary.passed,
    failed: summary.failed,
  });
}

/** Human-readable report. */
export function renderHuman(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`Conformance run against ${summary.url}`);
  lines.push('');

  if (summary.cases.length === 0) {
    lines.push('0 cases run');
  } else {
    const idWidth = Math.max(2, ...summary.cases.map((c) => c.id.length));
    for (const c of summary.cases) {
      const status = c.pass ? 'PASS' : 'FAIL';
      const detail = c.detail ? `  ${c.detail}` : '';
      lines.push(`  ${status}  ${c.id.padEnd(idWidth)}${detail}`);
    }
  }

  lines.push('');
  lines.push(`${summary.passed} passed, ${summary.failed} failed`);
  return lines.join('\n');
}
