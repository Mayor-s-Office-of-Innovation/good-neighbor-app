// Who is this request, and which tenant partition may it touch? The answer is
// the `custom:siteId` claim carried by the request's authorizer (set by the
// device-token REQUEST authorizer today, Cognito later — ADR 0010), enforced at
// the APPLICATION layer (every handler partitions on this value). The
// platform-layer backstop — the IAM `dynamodb:LeadingKeys = SITE#<custom:siteId>`
// condition (docs/dynamodb-data-model.md § Identity model) — is the target
// design, not yet in the deployed role. It is derived
// server-side and NEVER read from the request body: a client cannot name the
// site it writes to.

/**
 * Thrown when an authorizer ran for the request but produced no usable
 * `custom:siteId` claim. That is a server-side contract break (authorizer and
 * handler disagree on the event shape), never a client error, so it surfaces
 * as a logged 500 via withServerErrorsLogged rather than a silent fallback to
 * the demo partition — which would write one tenant's data under another's.
 */
export class MissingSiteClaimError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MissingSiteClaimError";
    this.code = "missing_site_claim";
  }
}

/**
 * Derive the tenant siteId for a request from its verified principal.
 *
 * Three authorizer shapes can land claims at `event.requestContext.authorizer`:
 * - Lambda REQUEST authorizer (device tokens, ADR 0010) with an integration
 *   payload format of 2.0 — the deployed configuration (infra api.tf): API
 *   Gateway nests the authorizer's `context` map under `authorizer.lambda`,
 *   so the key is `authorizer.lambda["claims.custom:siteId"]`.
 * - Lambda REQUEST authorizer with payload format 1.0: the context map is
 *   flattened directly onto `authorizer["claims.custom:siteId"]`.
 * - JWT/Cognito authorizer (incl. the local X-Debug stub): nested —
 *   `authorizer.jwt.claims["custom:siteId"]`.
 *
 * Fallback is fail-closed: `DEMO_SITE_ID` (default `"demo-site"`) is used
 * ONLY when the event carries no authorizer at all (the anonymous/local
 * posture). An authorizer that ran but yielded no claim throws
 * `MissingSiteClaimError` — every authorizer-gated route in production must
 * carry the claim, and defaulting there would silently merge tenants.
 * @param {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer} event
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 * @throws {MissingSiteClaimError} when an authorizer is present without a claim
 */
export function deriveSiteId(event, env = process.env) {
  // The deployed event carries either authorizer shape depending on route;
  // type it as the union the postures produce.
  const authorizer = /** @type {Record<string, any> | undefined} */ (
    /** @type {any} */ (event.requestContext?.authorizer)
  );
  if (!authorizer || typeof authorizer !== "object") {
    return env.DEMO_SITE_ID || "demo-site";
  }
  const claim =
    authorizer.lambda?.["claims.custom:siteId"] ?? // REQUEST authorizer, payload 2.0
    authorizer["claims.custom:siteId"] ?? // REQUEST authorizer, payload 1.0
    authorizer.jwt?.claims?.["custom:siteId"]; // JWT authorizer (nested)
  if (typeof claim === "string" && claim.length > 0) return claim;
  throw new MissingSiteClaimError(
    "authorizer present but no custom:siteId claim on the request " +
      `(authorizer keys: ${Object.keys(authorizer).join(",") || "none"})`,
  );
}
