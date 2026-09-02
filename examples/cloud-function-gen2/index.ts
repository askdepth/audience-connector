// Google Cloud Functions (2nd gen) HTTP function.
//
// Cloud Functions gen2 runs on Cloud Run and uses the Functions Framework,
// whose HTTP signature is Express-style `(req, res)`. This example is the
// connector's Express shim exported under a function name — again, no
// bespoke adaptation.
//
// Deploy:
//   gcloud functions deploy audience-connector \
//     --gen2 --runtime=nodejs22 --trigger-http \
//     --entry-point=audienceConnector
//
// The Functions Framework must receive the raw body. Set
//   --set-env-vars=FUNCTION_SIGNATURE_TYPE=http
// (the default) and do NOT add a JSON body parser in front of it — the shim
// reads the raw bytes itself, which is what the HMAC signature is computed
// over.

import { createConnector, restAdapter } from '@askdepth/audience-connector';
import { expressHandler } from '@askdepth/audience-connector/express';

const connector = createConnector({
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
    fetchCandidates: async () => [],
    fetchCount: async () => 0,
  }),
});

export const audienceConnector = expressHandler(connector);
