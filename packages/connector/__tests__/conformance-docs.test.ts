// S5 (C) — docs/conformance.md must map every negative case to a real broken
// fixture. Same spirit as `conformance-self-check.test.ts`: a doc that
// silently loses a row is worse than none.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..', '..', '..');
const doc = readFileSync(resolve(REPO, 'docs', 'conformance.md'), 'utf8');

const NEGATIVE_IDS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'] as const;

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
