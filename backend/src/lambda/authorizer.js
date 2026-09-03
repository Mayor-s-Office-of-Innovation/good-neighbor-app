// API Gateway (HTTP API v2) REQUEST authorizer for the device tokens (Option 4
// device auth — docs/adr/0010-device-token-auth.md). Verifies the Bearer JWT
// (signature + expiry via lib/device-token.js), checks it against the DEVICE#
// item (revocation via the `ver` ↔ tokenGeneration comparison), and returns a
// simple-response whose context lands at
// event.requestContext.authorizer.jwt.claims — exactly the shape
// lib/principal.js (deriveSiteId) and every handler already read.
//
// Attached to every route except the bootstrap/intake set (see api.tf). API
// Gateway caches by the Authorization header value; the TTL (set in Terraform,
// kept small) bounds how long a revocation takes to propagate.

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { DeviceTokenError, verifyDeviceToken } from "../lib/device-token.js";

/** The API Gateway v2 simple-response `Allow` shape. */
const ALLOW = { isAuthorized: true, context: {} };
/**
 * Build a `Deny` simple response with a reason code.
 * @param {{ reason?: string }} [detail]
 * @returns {{ isAuthorized: boolean, context: Record<string, string> }}
 */
const DENY = ({ reason = "unauthorized" } = {}) => ({
  isAuthorized: false,
  context: { reason },
});

/**
 * The API Gateway v2 request-authorizer event. `@types/aws-lambda` doesn't ship
 * a named type for this shape, so type it locally: v2 proxy event minus the
 * unused body fields, with a case-variant header map.
 * @typedef {{ headers?: Record<string, string | undefined> }} AuthorizerEvent
 */

/**
 * Verify the Bearer device token and answer the gateway.
 * @param {AuthorizerEvent} event
 * @returns {Promise<{ isAuthorized: boolean, context: Record<string, unknown> }>} an
 *   API Gateway v2 simple response
 */
export const handler = async (event) => {
  const header =
    event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const token = bearerToken(header ?? "");
  if (!token) return DENY({ reason: "missing_token" });

  let claims;
  try {
    claims = await verifyDeviceToken(token);
  } catch (err) {
    return DENY({
      reason: err instanceof DeviceTokenError ? err.code : "unknown",
    });
  }
  if (claims.typ !== "access") {
    return DENY({ reason: "not_an_access_token" });
  }

  // Live check against the DEVICE# item: revocation (generation bumped or
  // device deleted) kills a still-cryptographically-valid token instantly.
  const res = await ddb.send(
    new GetCommand({
      TableName: process.env.DYNAMO_TABLE,
      Key: { pk: `SITE#${claims.siteId}`, sk: `DEVICE#${claims.sub}` },
    }),
  );
  const device = /** @type {{ tokenGeneration?: number } | undefined} */ (
    res.Item
  );
  if (!device || device.tokenGeneration !== claims.ver) {
    return DENY({ reason: "revoked" });
  }

  return {
    ...ALLOW,
    // Field-for-field what API Gateway's JWT authorizer produces — handlers
    // read event.requestContext.authorizer.jwt.claims["custom:siteId"] today.
    context: {
      jwt: {
        claims: {
          sub: claims.sub,
          "custom:siteId": claims.siteId,
          ver: claims.ver,
        },
      },
    },
  };
};

/**
 * @param {string} header
 * @returns {string} the token, or "" when the header isn't a Bearer token
 */
function bearerToken(header) {
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : "";
}
