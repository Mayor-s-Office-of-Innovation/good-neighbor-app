// API Gateway (HTTP API v2) REQUEST authorizer for the device tokens (Option 4
// device auth — docs/adr/0010-device-token-auth.md). Verifies the Bearer JWT
// (signature + expiry via lib/device-token.js), checks it against the DEVICE#
// item (revocation via the `ver` ↔ tokenGeneration comparison), and returns a
// simple-response whose flat context keys land at
// event.requestContext.authorizer["claims.<claim>"] — the REQUEST-authorizer
// shape lib/principal.js (deriveSiteId) reads.
//
// Attached to every route except the bootstrap/intake set (see api.tf). API
// API Gateway caching is disabled in Terraform so every protected request sees
// the current binding, Site, and Manager membership state.

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { deviceLivenessProblem } from "../lib/device-liveness.js";
import {
  canonicalAccessLevel,
  DeviceTokenError,
  verifyDeviceToken,
} from "../lib/device-token.js";

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
  const device = /** @type {Record<string, any> | undefined} */ (res.Item);
  const now = new Date();
  if (
    !device ||
    deviceLivenessProblem(device, now) ||
    device.tokenGeneration !== claims.ver ||
    canonicalAccessLevel(device.accessLevel) !== claims.accessLevel
  ) {
    return DENY({ reason: "revoked" });
  }

  const siteRes = await ddb.send(
    new GetCommand({
      TableName: process.env.DYNAMO_TABLE,
      Key: { pk: `SITE#${claims.siteId}`, sk: "#META" },
    }),
  );
  const site = /** @type {Record<string, any> | undefined} */ (siteRes.Item);
  if (!site || site.status === "inactive") {
    return DENY({ reason: "site_inactive" });
  }
  if (
    Number(device.siteCredentialGeneration ?? 0) !==
    Number(site.siteCredentialGeneration ?? 0)
  ) {
    return DENY({ reason: "revoked" });
  }
  if (
    claims.accessLevel === "manager" &&
    device.authorityScope === "provider"
  ) {
    if (!device.providerId || site.providerId !== device.providerId) {
      return DENY({ reason: "revoked" });
    }
    const membershipResult = await ddb.send(
      new GetCommand({
        TableName: process.env.DYNAMO_TABLE,
        Key: {
          pk: `PROVIDER#${device.providerId}`,
          sk: `PROVIDER_MANAGER#${device.providerMembershipId}`,
        },
      }),
    );
    let membership = membershipResult.Item;
    // Imported memberships may have a managerId-based sort key that predates
    // provider enrollment. Resolve that bounded Provider partition safely.
    if (!membership) {
      const matches = await ddb.send(
        new QueryCommand({
          TableName: process.env.DYNAMO_TABLE,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": `PROVIDER#${device.providerId}`,
            ":prefix": "PROVIDER_MANAGER#",
          },
        }),
      );
      membership = matches.Items?.find(
        (item) => item.membershipId === device.providerMembershipId,
      );
    }
    if (
      !membership ||
      membership.status !== "active" ||
      Number(membership.generation ?? 0) !==
        Number(device.providerMembershipGeneration ?? -1)
    ) {
      return DENY({ reason: "revoked" });
    }
  } else if (claims.accessLevel === "manager" && device.membershipId) {
    const membershipResult = await ddb.send(
      new GetCommand({
        TableName: process.env.DYNAMO_TABLE,
        Key: {
          pk: `SITE#${claims.siteId}`,
          sk: `MANAGER_MEMBERSHIP#${device.membershipId}`,
        },
      }),
    );
    const membership = membershipResult.Item;
    if (
      !membership ||
      membership.status !== "active" ||
      Number(membership.generation ?? 0) !==
        Number(device.membershipGeneration ?? -1)
    ) {
      return DENY({ reason: "revoked" });
    }
  }

  return {
    ...ALLOW,
    // REQUEST-authorizer context: keys flatten to $context.authorizer.<key>
    // and land at event.requestContext.authorizer.<key> on the integration
    // event. The `jwt.claims` nesting is reserved for JWT authorizers (a
    // REQUEST authorizer's context may not populate it), so the claims are
    // emitted flat; lib/principal.js reads both shapes.
    // Values must be string|number|boolean|null (coerced otherwise).
    context: {
      "claims.sub": claims.sub,
      "claims.custom:siteId": claims.siteId,
      "claims.ver": claims.ver,
      "claims.accessLevel": claims.accessLevel,
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
