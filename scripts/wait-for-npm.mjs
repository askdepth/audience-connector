#!/usr/bin/env node
/**
 * postpublish helper for @askdepth/audience-contract.
 *
 * `changeset publish` releases packages in dependency order in one process.
 * npm is not read-your-writes, so the connector publish can race ahead of the
 * contract version becoming visible. Sleep until `npm view` sees this package
 * version before the next package is published.
 *
 * Expected cwd: the package directory being published (npm lifecycle default).
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const { name, version } = pkg;

if (!name || !version) {
  console.error('wait-for-npm: package.json missing name/version');
  process.exit(1);
}

const maxAttempts = 30;
const delayMs = 10_000;

for (let i = 1; i <= maxAttempts; i++) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      stdio: 'pipe',
    });
    console.log(`${name}@${version} visible on registry after attempt ${i}`);
    process.exit(0);
  } catch {
    console.log(
      `waiting for ${name}@${version} (attempt ${i}/${maxAttempts})...`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

console.error(
  `::error::${name}@${version} not visible on the registry after ${(maxAttempts * delayMs) / 1000}s`,
);
process.exit(1);
