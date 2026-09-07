// S5 (C) — docs/conformance.md must map every negative case to a real broken
// fixture. Same spirit as `conformance-self-check.test.ts`: a doc that
// silently loses a row is worse than none.
//
// S10 — and it must document all 15 cases (P1–P7, N1–N8). The canonical case
// set is parsed out of docs/conformance-spec.md, mapped to ids the same way
// docs/conformance-self-check.md does (spec order), and every id must appear
// exactly once in docs/conformance.md as a table row with a non-empty
// one-line description. If a future edit drops a case from the CLI guide, this
// fails.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..', '..');
const doc = readFileSync(resolve(REPO, 'docs', 'conformance.md'), 'utf8');
const spec = readFileSync(resolve(REPO, 'docs', 'conformance-spec.md'), 'utf8');

const NEGATIVE_IDS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'] as const;

/** Count the numbered list items in the spec section that starts at `marker`. */
function countSpecItems(marker: string): number {
  const from = spec.indexOf(marker);
  expect(from, `section "${marker}" not found in conformance-spec.md`).toBeGreaterThan(-1);
  const rest = spec.slice(from + marker.length);
  const end = rest.search(/\nA connector \*\*must pass\*\*|\n## /);
  const block = end === -1 ? rest : rest.slice(0, end);
  return (block.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
}

describe('docs/conformance.md maps every negative case to a broken fixture', () => {
  for (const id of NEGATIVE_IDS) {
    it(`${id} has exactly one row with a non-empty fixture reference that exists`, () => {
      const rows = doc.split('\n').filter((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l));
      expect(rows.length, `${id}: expected exactly one table row`).toBe(1);

      const cells = rows[0].split('|').map((c) => c.trim());
      // | id | description | fixture | violation |
      expect(cells[2].length, `${id}: empty case description`).toBeGreaterThan(0);

      const fixtureCell = cells[3];
      expect(fixtureCell, `${id}: fixture cell names no fixtures path`).toMatch(
        /__tests__\/fixtures\//,
      );

      const m = fixtureCell.match(/\(([^)]*__tests__\/fixtures\/[^)]+)\)/);
      expect(m, `${id}: fixture cell has no linked path`).not.toBeNull();
      const relFromDocs = m![1].replace(/^\.\.\//, '');
      expect(existsSync(resolve(REPO, relFromDocs)), `${id}: ${relFromDocs} does not exist`).toBe(
        true,
      );

      expect(cells[4].length, `${id}: empty violation description`).toBeGreaterThan(10);
    });
  }

  it('names all 8 fixture directories', () => {
    for (const dir of [
      'unsigned-ok',
      'weak-signature',
      'leaky-columns',
      'leaky-errors',
      'nondeterministic-cursor',
      'no-row-cap',
      'fake-random-sample',
      'write-path-exposed',
    ]) {
      expect(doc).toContain(`__tests__/fixtures/${dir}/`);
    }
  });
});

describe('docs/conformance.md documents every spec case exactly once', () => {
  const negativeCount = countSpecItems('A connector **fails** conformance if it:');
  const positiveCount = countSpecItems('A connector **must pass**, to activate:');

  const caseIds = [
    ...Array.from({ length: positiveCount }, (_, i) => `P${i + 1}`),
    ...Array.from({ length: negativeCount }, (_, i) => `N${i + 1}`),
  ];

  it('spec has the expected shape (7 positive + 8 negative)', () => {
    expect(positiveCount).toBe(7);
    expect(negativeCount).toBe(8);
  });

  for (const id of caseIds) {
    it(`${id} appears exactly once as a table row with a non-empty description`, () => {
      const rows = doc.split('\n').filter((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l));
      expect(rows.length, `${id}: expected exactly one table row in docs/conformance.md`).toBe(1);

      const cells = rows[0].split('|').map((c) => c.trim());
      // ['', id, description, ...]
      expect(cells[2]?.length ?? 0, `${id}: empty one-line description`).toBeGreaterThan(0);
    });
  }
});
