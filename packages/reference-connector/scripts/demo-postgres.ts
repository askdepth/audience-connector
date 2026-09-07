// `pnpm --filter @askdepth/reference-connector demo:postgres`
//
// Boots the Postgres reference-connector variant against an already-running,
// already-seeded Postgres and then stays up until interrupted (Ctrl-C). This
// is the M2 sales-demo entrypoint — a live connector a human can point the
// conformance CLI at without any platform UI:
//
//   REFERENCE_SECRET=… DATABASE_URL=… \
//     pnpm --filter @askdepth/reference-connector demo:postgres
//
//   # then, in another shell:
//   node packages/connector/dist/bin/conformance.js conformance \
//     --url <printed url> --secret <printed secret> \
//     --unmapped-column internal_notes --unmapped-column crm_account_id \
//     --filter-only-attribute country
//
// For a one-command demo that also brings up the database, see
// `docker compose up` (packages/reference-connector/docker-compose.yml).

import { start } from '../src/postgres-variant';

async function main(): Promise<void> {
  const variant = await start();

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Askdepth reference connector (postgres variant) is up.');
  // eslint-disable-next-line no-console
  console.log(`  url:    ${variant.url}`);
  // eslint-disable-next-line no-console
  console.log(`  secret: ${variant.secret}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Point the conformance CLI at it:');
  // eslint-disable-next-line no-console
  console.log(
    '  node packages/connector/dist/bin/conformance.js conformance \\\n' +
      `    --url ${variant.url} --secret ${variant.secret} \\\n` +
      '    --unmapped-column internal_notes --unmapped-column crm_account_id \\\n' +
      '    --filter-only-attribute country',
  );
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Press Ctrl-C to stop.');

  const shutdown = (signal: NodeJS.Signals): void => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received — shutting down.`);
    variant.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
