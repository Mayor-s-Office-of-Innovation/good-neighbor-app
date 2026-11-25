import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { queryAllItems } from "./query-all-items.js";

/** Validate and checkpoint the Provider Manager authority behind an invitation.
 * All snapshots are server-derived; older invitations without them fail closed.
 * @param {string} tableName @param {Record<string, any>} site
 * @param {Record<string, any> | undefined} binding
 * @param {Record<string, any>} [grant]
 */
export async function providerInvitationAuthority(
  tableName,
  site,
  binding,
  grant,
) {
  const now = new Date().toISOString();
  if (
    !binding ||
    binding.status !== "active" ||
    binding.accessLevel !== "manager" ||
    binding.authorityScope !== "provider" ||
    !binding.providerId ||
    !binding.providerMembershipId ||
    site.status !== "active" ||
    site.providerId !== binding.providerId ||
    (binding.absoluteExpiresAt && binding.absoluteExpiresAt <= now) ||
    Number(site.providerAccessGeneration ?? 0) !==
      Number(binding.providerAccessGeneration ?? 0) ||
    Number(site.siteCredentialGeneration ?? 0) !==
      Number(binding.siteCredentialGeneration ?? 0)
  )
    return null;
  const snapshot = {
    issuerAuthorityScope: "provider",
    issuerProviderId: binding.providerId,
    issuerProviderMembershipId: binding.providerMembershipId,
    issuerProviderMembershipGeneration: Number(
      binding.providerMembershipGeneration ?? -1,
    ),
    issuerProviderAccessGeneration: Number(
      binding.providerAccessGeneration ?? 0,
    ),
    issuerSiteCredentialGeneration: Number(
      binding.siteCredentialGeneration ?? 0,
    ),
  };
  if (
    grant &&
    Object.entries(snapshot).some(([key, value]) => grant[key] !== value)
  )
    return null;
  const [providerResult, result] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PROVIDER#${binding.providerId}`, sk: "#META" },
        ConsistentRead: true,
      }),
    ),
    queryAllItems({
      TableName: tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `PROVIDER#${binding.providerId}`,
        ":prefix": "PROVIDER_MANAGER#",
      },
      ConsistentRead: true,
    }),
  ]);
  if (providerResult.Item?.status === "inactive") return null;
  const membership = (result.Items || []).find(
    (item) => item.membershipId === binding.providerMembershipId,
  );
  if (
    !membership ||
    membership.status !== "active" ||
    Number(membership.generation ?? 0) !==
      snapshot.issuerProviderMembershipGeneration
  )
    return null;
  const siteCheck = {
    TableName: tableName,
    Key: { pk: `SITE#${site.siteId}`, sk: "#META" },
    ConditionExpression:
      "#authStatus = :authActive AND providerId = :authProvider AND (providerAccessGeneration = :authProviderGeneration OR (attribute_not_exists(providerAccessGeneration) AND :authProviderGeneration = :authZero)) AND (siteCredentialGeneration = :authSiteGeneration OR (attribute_not_exists(siteCredentialGeneration) AND :authSiteGeneration = :authZero))",
    ExpressionAttributeNames: { "#authStatus": "status" },
    ExpressionAttributeValues: {
      ":authActive": "active",
      ":authProvider": binding.providerId,
      ":authProviderGeneration": snapshot.issuerProviderAccessGeneration,
      ":authSiteGeneration": snapshot.issuerSiteCredentialGeneration,
      ":authZero": 0,
    },
  };
  return {
    snapshot,
    siteCheck,
    checks: [
      {
        ConditionCheck: {
          TableName: tableName,
          Key: { pk: binding.pk, sk: binding.sk },
          ConditionExpression:
            "#authStatus = :authActive AND accessLevel = :authManager AND authorityScope = :authScope AND providerId = :authProvider AND providerMembershipId = :authMembership AND providerMembershipGeneration = :authGeneration AND (attribute_not_exists(absoluteExpiresAt) OR absoluteExpiresAt > :authNow)",
          ExpressionAttributeNames: { "#authStatus": "status" },
          ExpressionAttributeValues: {
            ":authActive": "active",
            ":authManager": "manager",
            ":authScope": "provider",
            ":authProvider": binding.providerId,
            ":authMembership": binding.providerMembershipId,
            ":authGeneration": snapshot.issuerProviderMembershipGeneration,
            ":authNow": now,
          },
        },
      },
      {
        ConditionCheck: {
          TableName: tableName,
          Key: { pk: membership.pk, sk: membership.sk },
          ConditionExpression:
            "#authStatus = :authActive AND generation = :authGeneration",
          ExpressionAttributeNames: { "#authStatus": "status" },
          ExpressionAttributeValues: {
            ":authActive": "active",
            ":authGeneration": snapshot.issuerProviderMembershipGeneration,
          },
        },
      },
      // A provider deactivated after the read above must still stop this
      // redemption. Same rule as the read: only an explicit "inactive" refuses.
      {
        ConditionCheck: {
          TableName: tableName,
          Key: { pk: `PROVIDER#${binding.providerId}`, sk: "#META" },
          ConditionExpression:
            "attribute_not_exists(#authStatus) OR #authStatus <> :authInactive",
          ExpressionAttributeNames: { "#authStatus": "status" },
          ExpressionAttributeValues: { ":authInactive": "inactive" },
        },
      },
    ],
  };
}
