// Who is this request, and which tenant partition may it touch? The answer is
// the JWT `custom:siteId` claim (set by Cognito, enforced at the platform layer
// by the IAM `dynamodb:LeadingKeys = SITE#<custom:siteId>` condition — see
// docs/dynamodb-data-model.md § Identity model). It is derived server-side and
// NEVER read from the request body: a client cannot name the site it writes to.

/**
 * Derive the tenant siteId for a request from its JWT claim.
 *
 * In the demo/local posture the JWT authorizer isn't present, so the claim is
 * absent and we fall back to `DEMO_SITE_ID` (default `"demo-site"`). Production
 * requests always carry the claim.
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function deriveSiteId(event, env = process.env) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const claim = claims?.["custom:siteId"];
  if (typeof claim === "string" && claim.length > 0) return claim;
  return env.DEMO_SITE_ID || "demo-site";
}
