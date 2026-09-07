// `pnpm --filter @askdepth/reference-connector demo:rest`
//
// Boots the rest variant of the Askdepth reference connector — the in-memory
// fixture backend (the "client's own backend" stand-in) plus the connector in
// front of it — and stays up until interrupted (Ctrl-C). This is an M2
// sales-demo entrypoint: a live connector a human can point the conformance CLI
// at, with no database and no platform UI.
//
//   REFERENCE_SECRET=… pnpm --filter @askdepth/reference-connector demo:rest
//
//   # then, in another shell:
//   node packages/connector/dist/bin/conformance.js conformance \
//     --url <printed url> --secret <printed secret> \
//     --unmapped-column internal_notes --unmapped-column crm_account_id \
//     --filter-only-attribute country
//
// Same seed, same field mapping and same 15 conformance results as the Postgres
// variant (`demo:postgres`) — served through `restAdapter` instead of
// `postgresAdapter`.

import { start } from '../src/rest-variant';

async function main(): Promise<void> {
  const variant = await start();

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Askdepth reference connector (rest variant) is up.');
  // eslint-disable-next-line no-console
  console.log(`  url:    ${variant.url}`);
  // eslint-disable-next-line no-console
  console.log(`  secret: ${variant.secret}`);
  // eslint-disable-next-line no-console
  console.log('  backend: in-memory fixture API (5,000-row S6 seed)');
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
