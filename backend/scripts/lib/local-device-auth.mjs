// Run the same live device-token authorization locally that API Gateway runs
// in deployed environments. Signature verification alone is insufficient:
// revocation changes the DEVICE# row while the signed access token remains
// cryptographically valid until its expiry.

import { handler as authorizeDevice } from "../../src/lambda/authorizer.js";

/**
 * @typedef {{ sub: string, siteId: string, ver: number, accessLevel: "general"|"manager" }} LocalDeviceClaims
 */

/**
 * Resolve a Bearer token to the authorizer claims used by the local proxy.
 * No token (or no configured signing secret) retains the local X-Debug stub
 * posture. A denied token returns an error and must never fall back to stubs.
 *
 * @param {Record<string, string | undefined>} headers
 * @param {(event: { headers: Record<string, string | undefined> }) => Promise<{ isAuthorized: boolean, context?: Record<string, unknown> }>} [authorize]
 * @returns {Promise<LocalDeviceClaims | { error: string } | null>}
 */
export async function resolveDeviceClaims(
  headers,
  authorize = authorizeDevice,
) {
  const authorization = headers.authorization ?? headers.Authorization ?? "";
  if (!/^Bearer\s+.+$/i.test(authorization.trim())) return null;
  if (!process.env.DEVICE_TOKEN_SECRET) return null;

  const verdict = await authorize({ headers });
  if (!verdict.isAuthorized) {
    return {
      error: String(verdict.context?.reason ?? "unauthorized"),
    };
  }

  const context = verdict.context ?? {};
  const sub = context["claims.sub"];
  const siteId = context["claims.custom:siteId"];
  const ver = Number(context["claims.ver"]);
  const accessLevel = context["claims.accessLevel"];
  if (
    typeof sub !== "string" ||
    typeof siteId !== "string" ||
    !Number.isFinite(ver) ||
    (accessLevel !== "general" && accessLevel !== "manager")
  ) {
    return { error: "invalid_authorizer_context" };
  }

  return { sub, siteId, ver, accessLevel };
}
