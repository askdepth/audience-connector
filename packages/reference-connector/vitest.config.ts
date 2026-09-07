import { defineConfig } from 'vitest/config';

// The DB-gated suites (`postgres-variant.test.ts`, the `rest-variant.test.ts`
// cross-check) each seed and drop the shared `reference_users` table in
// whatever Postgres they are handed. Run test files serially so the two cannot
// race on that table when a database is present. The suite is small (4 files),
// so the cost is negligible; `hookTimeout` is raised because seeding 5,000 rows
// from `fixtures.sql` runs in `beforeAll`.
export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
