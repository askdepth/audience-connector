// AWS Lambda shim — API Gateway HTTP API (payload format v2).
//
// The event structurally matches `@types/aws-lambda`'s
// `APIGatewayProxyEventV2` / `APIGatewayProxyStructuredResultV2`; the minimal
// shapes are declared here so the package pulls in no type dependency.
//
//   export const handler = lambdaHandler(connector);

import { toPlainResponse, toWebRequest, type Connector } from './_common';

export interface LambdaEventV2 {
  version?: string;
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    http: { method: string; path?: string; sourceIp?: string };
    domainName?: string;
  };
}

export interface LambdaResultV2 {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}

export type LambdaHandlerV2 = (event: LambdaEventV2) => Promise<LambdaResultV2>;

export function lambdaHandler(connector: Connector): LambdaHandlerV2 {
  return async function askdepthLambdaHandler(event: LambdaEventV2): Promise<LambdaResultV2> {
    const method = event.requestContext.http.method.toUpperCase();
    const headerBag = event.headers ?? {};
    const host = headerBag.host ?? headerBag.Host ?? event.requestContext.domainName ?? 'lambda';
    const query = event.rawQueryString ? `?${event.rawQueryString}` : '';

    let rawBody = new Uint8Array();
    if (event.body != null && method !== 'GET' && method !== 'HEAD') {
      rawBody = event.isBase64Encoded
        ? Uint8Array.from(atob(event.body), (c) => c.charCodeAt(0))
        : new TextEncoder().encode(event.body);
    }

    const headers: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(headerBag)) {
      if (v !== undefined) headers.push([k, v]);
    }
    if (event.cookies?.length) headers.push(['cookie', event.cookies.join('; ')]);

    const request = toWebRequest({
      method,
      url: `https://${host}${event.rawPath}${query}`,
      headers,
      rawBody,
    });

    const { status, headers: respHeaders, body } = await toPlainResponse(await connector.fetch(request));
    return { statusCode: status, headers: respHeaders, body, isBase64Encoded: false };
  };
}
