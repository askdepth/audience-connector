// Next.js App Router route handler (Node runtime).
//
// The connector is a Web-standard `Request → Response` function, which is
// exactly what a Next.js route handler exports — so this file contains *no*
// adaptation code. It runs the unmodified `@askdepth/audience-connector`
// build.
//
// Deploy: put this at `app/askdepth/[[...route]]/route.ts`. The optional
// catch-all segment lets `/askdepth/v1/health`, `/askdepth/v1/candidates/*`
// etc. all resolve here; the connector does its own routing on `basePath`.

import { createConnector, restAdapter } from '@askdepth/audience-connector';

const connector = createConnector({
  // In a real deployment: `process.env.AUDIENCE_CONNECTOR_SECRET`.
  secret: process.env.AUDIENCE_CONNECTOR_SECRET ?? 'example-secret-do-not-ship',
  fieldMapping: { externalId: 'id', email: 'email', segment: 'plan' },
  adapter: restAdapter({
    declaredSchema: {
      columns: [
        { name: 'id', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'plan', type: 'string' },
      ],
    },
    // A real connector calls the client's own user service here.
    fetchCandidates: async () => [],
    fetchCount: async () => 0,
  }),
});

export const runtime = 'nodejs';

export const GET = (request: Request): Promise<Response> => connector.fetch(request);
export const POST = (request: Request): Promise<Response> => connector.fetch(request);
