# Cloud Functions gen2 example

`index.ts` exports the connector's Express shim under the entry-point name
`audienceConnector`. Cloud Functions gen2 runs the Functions Framework, whose
HTTP signature is Express-style, so this is the whole integration.

```bash
gcloud functions deploy audience-connector \
  --gen2 --runtime=nodejs22 --trigger-http \
  --entry-point=audienceConnector --region=... \
  --set-secrets=AUDIENCE_CONNECTOR_SECRET=...
```

Do not put a JSON body parser in front of it — the shim reads the raw bytes,
which is what the HMAC signature covers.

Verified in CI: `packages/connector/__tests__/runtime.test.ts` invokes this
export through the Functions Framework request/response shape with a signed
request.
