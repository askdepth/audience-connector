# Next.js route handler example

`app/askdepth/[[...route]]/route.ts` mounts `@askdepth/audience-connector` in a
Next.js App Router project with **zero adaptation code** — the connector is
already a Web-standard `Request → Response` function.

```bash
pnpm add @askdepth/audience-connector
# copy route.ts to app/askdepth/[[...route]]/route.ts
# set AUDIENCE_CONNECTOR_SECRET
```

The catch-all segment routes `/askdepth/v1/*` to the handler; the connector
does its own routing on `basePath`.

Verified in CI: `packages/connector/__tests__/runtime.test.ts` imports this
file's `GET`/`POST` exports and drives a signed request end to end.
