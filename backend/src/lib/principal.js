// Who is this request, and which tenant partition may it touch? The answer is
// the `custom:siteId` claim carried by the request's authorizer (set by the
// device-token REQUEST authorizer today, Cognito later — ADR 0010), enforced at
// the platform layer by the IAM `dynamodb:LeadingKeys = SITE#<custom:siteId>`
// condition (docs/dynamodb-data-model.md § Identity model). It is derived
// server-side and NEVER read from the request body: a client cannot name the
// site it writes to.

/**
 * Derive the tenant siteId for a request from its verified principal.
 *
 * Two authorizer shapes land claims at `event.requestContext.authorizer`:
 * - Lambda REQUEST authorizer (device tokens, ADR 0010): flat context keys —
 *   `authorizer["claims.custom:siteId"]` (API Gateway flattens the authorizer's
 *   `context` map to `$context.authorizer.<key>`).
 * - JWT/Cognito authorizer (incl. the local X-Debug stub): nested —
 *   `authorizer.jwt.claims["custom:siteId"]`.
 * When neither is present (demo/local posture) we fall back to `DEMO_SITE_ID`
 * (default `"demo-site"`). Production requests always carry the claim.
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function deriveSiteId(event, env = process.env) {
  // The deployed event carries either authorizer shape depending on route;
  // type it as the union the two postures produce.
  const authorizer =
    /** @type {Record<string, any> | undefined} */ (
      /** @type {any} */ (event.requestContext?.authorizer)
    ) ?? {};
  const claim =
    authorizer["claims.custom:siteId"] ?? // REQUEST authorizer (flat)
    authorizer?.jwt?.claims?.["custom:siteId"]; // JWT authorizer (nested)
  if (typeof claim === "string" && claim.length > 0) return claim;
  return env.DEMO_SITE_ID || "demo-site";
}
