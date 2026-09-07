// Builds a faithful-enough APIGatewayProxyEventV2 (with a JWT authorizer) from a
// Node http request, so the local router can invoke the *real* Lambda handlers
// unchanged. Kept in its own module (no server side effects) so it can be unit
// tested without booting the HTTP server or any JVM emulator.
//
// Only the fields the handlers actually read need to be correct; the rest are
// present for realism. The one field with behavioral impact is the authorizer
// `sub`, which stands in for the Cognito JWT claim locally.

import { randomUUID } from "node:crypto";

/**
 * @param {object} args
 * @param {string} args.method    HTTP method (e.g. "POST")
 * @param {string} args.path      URL path (e.g. "/submissions")
 * @param {Record<string, string | string[] | undefined>} args.headers  Node req.headers (already lowercased)
 * @param {string} [args.body]    Raw request body
 * @param {string} args.defaultSub  Fallback `sub` when no X-Debug-Sub header is present
 * @param {Record<string, string>} [args.pathParameters]  Path params extracted by the router (e.g. `{ checkId }`)
 * @param {Record<string, string>} [args.queryStringParameters]  Parsed query string (undefined when empty)
 * @param {string} [args.rawQueryString]  The raw query string (without the leading "?")
 * @returns {object} an APIGatewayProxyEventV2WithJWTAuthorizer-shaped event
 */
export function buildProxyEvent({
  method,
  path,
  headers,
  body,
  defaultSub,
  defaultSite,
  pathParameters,
  queryStringParameters,
  rawQueryString = "",
}) {
  // Node lowercases header names already; normalize to plain strings so the
  // handler's `event.headers["idempotency-key"]` lookup matches API Gateway,
  // which delivers header names lowercased.
  /** @type {Record<string, string>} */
  const flatHeaders = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    flatHeaders[key.toLowerCase()] = Array.isArray(value)
      ? value.join(",")
      : value;
  }

  const sub = flatHeaders["x-debug-sub"] ?? defaultSub;
  // X-Debug-Site stands in for the authorizer-injected `custom:siteId` claim
  // (deployed value comes from the device token; see lambda/authorizer.js).
  const siteId = flatHeaders["x-debug-site"] ?? defaultSite;
  const requestId = randomUUID();

  return {
    version: "2.0",
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString,
    headers: flatHeaders,
    // API Gateway omits these keys entirely when there are no params; handlers
    // read them with optional chaining, so mirror that (undefined, not {}).
    ...(pathParameters ? { pathParameters } : {}),
    ...(queryStringParameters ? { queryStringParameters } : {}),
    requestContext: {
      accountId: "000000000000",
      apiId: "local",
      domainName: "localhost",
      requestId,
      routeKey: `${method} ${path}`,
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: flatHeaders["user-agent"] ?? "local-harness",
      },
      // The stub Cognito authorizer. `sub` (X-Debug-Sub) and `custom:siteId`
      // (X-Debug-Site) are the only claims the handlers read.
      authorizer: {
        jwt: {
          claims: { sub, ...(siteId ? { "custom:siteId": siteId } : {}) },
          scopes: [],
        },
      },
    },
    body: body && body.length > 0 ? body : undefined,
    isBase64Encoded: false,
  };
}
