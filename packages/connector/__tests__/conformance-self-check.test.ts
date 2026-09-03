import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// S10 — documentation that silently loses a row is worse than none. This
// parses docs/conformance-spec.md for its case count and asserts every case
// id (N1..Nn, P1..Pm) appears exactly once in docs/conformance-self-check.md
// with a non-empty test reference.

const DOCS = resolve(__dirname, '..', '..', '..', 'docs');
const spec = readFileSync(resolve(DOCS, 'conformance-spec.md'), 'utf8');
const selfCheck = readFileSync(resolve(DOCS, 'conformance-self-check.md'), 'utf8');

/** Count the numbered list items in the section that starts at `heading`. */
function countItems(marker: string): number {
  const from = spec.indexOf(marker);
  expect(from, `section "${marker}" not found in conformance-spec.md`).toBeGreaterThan(-1);
  const rest = spec.slice(from + marker.length);
  const end = rest.search(/\nA connector \*\*must pass\*\*|\n## /);
  const block = end === -1 ? rest : rest.slice(0, end);
  return (block.match(/^\s*\d+\.\s+\S/gm) ?? []).length;
}

const negativeCount = countItems('A connector **fails** conformance if it:');
const positiveCount = countItems('A connector **must pass**, to activate:');

const expectedIds = [
  ...Array.from({ length: negativeCount }, (_, i) => `N${i + 1}`),
  ...Array.from({ length: positiveCount }, (_, i) => `P${i + 1}`),
];

describe('conformance self-check covers every spec case', () => {
  it('spec has the expected shape (8 negative + 7 positive)', () => {
    expect(negativeCount).toBe(8);
    expect(positiveCount).toBe(7);
  });

  for (const id of expectedIds) {
    it(`${id} appears exactly once with a non-empty test reference`, () => {
      // table rows look like:  | N1 | <case> | <refs> |
      const rows = selfCheck
        .split('\n')
        .filter((l) => new RegExp(`^\\|\\s*${id}\\s*\\|`).test(l));
      expect(rows.length, `${id}: expected exactly one row`).toBe(1);
      const cells = rows[0].split('|').map((c) => c.trim());
      // ['', id, case, refs, '']
      expect(cells[2].length, `${id}: empty case description`).toBeGreaterThan(0);
      expect(cells[3].length, `${id}: empty test reference`).toBeGreaterThan(3);
      expect(cells[3], `${id}: reference names no test file`).toMatch(/\.test\.ts/);
    });
  }
});
