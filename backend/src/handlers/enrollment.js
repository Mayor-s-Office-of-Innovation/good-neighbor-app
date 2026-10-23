import { checkCodeAttemptLimit } from "./code-attempt-limit.js";
import { enrollmentCodeVerifier } from "./enrollment-codes.js";
import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse, readJsonBody } from "../http.js";
import {
  sendManagerSecurityNotification,
  sendProviderManagerSecurityNotification,
} from "../integrations/email.js";
import { mintAccessToken, mintRefreshToken } from "../lib/device-token.js";
import { MAX_PROVIDER_ENROLLMENT_SITES } from "./admin-provider-managers.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const ABSOLUTE_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
const INACTIVITY_LIMIT_DAYS = 60;
const INVALID_GRANT = { error: "invalid_enrollment_grant" };

/**
 * Redeem a one-time enrollment grant into a physical-device identity,
 * one Site binding, and the existing device-token compatibility session.
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2}
 */
export const redeemEnrollmentGrant = async (event) => {
  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }
  const input = /** @type {Record<string, unknown>} */ (body ?? {});
  let grantId = clean(input.grantId);
  const code = clean(input.code).replace(/[\s-]/g, "").toUpperCase();
  const token = code || clean(input.token);
  const requestedPhysicalDeviceId = clean(input.physicalDeviceId);
  if ((!code && !grantId) || !token || (code && !/^[A-Z0-9]{6}$/.test(code))) {
    return rejectEnrollment(event, "invalid_credentials");
  }
  if (requestedPhysicalDeviceId && !validDeviceId(requestedPhysicalDeviceId)) {
    return jsonResponse(400, { error: "invalid_physical_device_id" });
  }

  if (code) {
    const limited = await checkCodeAttemptLimit();
    if (limited) return limited;
  }

  const tableName = getDynamoTableName();
  const tokenHash = code
    ? await enrollmentCodeVerifier(code)
    : createHash("sha256").update(token).digest("hex");
  const lookupResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `ENROLLMENT_TOKEN#${tokenHash}`, sk: "#META" },
      ConsistentRead: true,
    }),
  );
  const lookup = lookupResult.Item;
  if (!lookup || (!code && lookup.grantId !== grantId)) {
    return rejectEnrollment(event, "unknown_credentials");
  }
  grantId = String(lookup.grantId);
  const grantResult = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: lookup.grantPk, sk: lookup.grantSk },
      ConsistentRead: true,
    }),
  );
  const grant = grantResult.Item;
  const now = new Date();
  const nowIso = now.toISOString();
  if (
    !grant ||
    grant.tokenHash !== tokenHash ||
    !["general", "manager"].includes(grant.accessLevel) ||
    Boolean(code) !== (grant.deliveryMode === "code")
  ) {
    return rejectEnrollment(event, "invalid_credentials");
  }
  if (grant.status === "redeemed") {
    return rejectEnrollment(event, "already_used", 409, grant);
  }
  if (grant.status !== "pending") {
    return rejectEnrollment(event, "cancelled", 410, grant);
  }
  if (grant.expiresAt <= nowIso) {
    return rejectEnrollment(event, "expired", 410, grant);
  }

  if (grant.scope === "provider") {
    return redeemProviderEnrollment({
      event,
      input,
      grant,
      lookup,
      tokenHash,
      requestedPhysicalDeviceId,
      now,
      nowIso,
      tableName,
    });
  }

  const siteId = String(grant.siteId);
  const accessLevel = /** @type {"general"|"manager"} */ (grant.accessLevel);
  const membershipId =
    accessLevel === "manager" ? String(grant.membershipId) : "";
  const issuerBindingId =
    accessLevel === "general" ? String(grant.issuedByBindingId) : "";
  const label =
    clean(input.label).slice(0, 100) ||
    clean(grant.label).slice(0, 100) ||
    (accessLevel === "manager" ? "Site Manager device" : "Team device");
  const physicalDeviceId = requestedPhysicalDeviceId || randomUUID();
  const [siteResult, authorityResult, physicalResult] = await Promise.all([
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `SITE#${siteId}`, sk: "#META" },
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${siteId}`,
          sk:
            accessLevel === "manager"
              ? `MANAGER_MEMBERSHIP#${membershipId}`
              : `DEVICE_BINDING#${issuerBindingId}`,
        },
      }),
    ),
    ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PHYSICAL_DEVICE#${physicalDeviceId}`, sk: "#META" },
      }),
    ),
  ]);
  const site = siteResult.Item;
  const authority = authorityResult.Item;
  const physical = physicalResult.Item;
  const issuerMembership =
    accessLevel === "general" && grant.issuerMembershipId
      ? (
          await ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                pk: `SITE#${siteId}`,
                sk: `MANAGER_MEMBERSHIP#${grant.issuerMembershipId}`,
              },
            }),
          )
        ).Item
      : undefined;
  if (
    !site ||
    site.status === "inactive" ||
    !authority ||
    authority.status !== "active" ||
    (accessLevel === "general" && authority.accessLevel !== "manager") ||
    (accessLevel === "general" &&
      (!issuerMembership ||
        issuerMembership.status !== "active" ||
        Number(issuerMembership.generation ?? 0) !==
          Number(grant.issuerMembershipGeneration ?? -1))) ||
    physical?.status === "revoked"
  ) {
    return rejectEnrollment(event, "access_unavailable", 403, grant);
  }

  const bindingId = randomUUID();
  const generation = 1;
  const [access, refresh] = await Promise.all([
    mintAccessToken(
      {
        siteId,
        deviceId: bindingId,
        tokenGeneration: generation,
        accessLevel,
      },
      { expiresIn: ACCESS_TTL_SECONDS },
    ),
    mintRefreshToken(
      {
        siteId,
        deviceId: bindingId,
        tokenGeneration: generation,
        accessLevel,
      },
      { expiresIn: REFRESH_TTL_SECONDS },
    ),
  ]);
  const absoluteExpiresAt = new Date(
    now.getTime() + ABSOLUTE_LIFETIME_MS,
  ).toISOString();
  const siteGeneration = Number(site.siteCredentialGeneration ?? 0);
  const membershipGeneration =
    accessLevel === "manager" ? Number(authority.generation ?? 1) : undefined;
  const binding = {
    pk: `SITE#${siteId}`,
    sk: `DEVICE_BINDING#${bindingId}`,
    type: "deviceBinding",
    entityType: "DEVICE_BINDING",
    bindingId,
    physicalDeviceId,
    siteId,
    accessLevel,
    ...(accessLevel === "manager"
      ? { membershipId, membershipGeneration }
      : {}),
    siteCredentialGeneration: siteGeneration,
    label,
    status: "active",
    tokenGeneration: generation,
    refreshJti: refresh.jti,
    enrolledAt: nowIso,
    enrolledByGrantId: grantId,
    lastSeenAt: nowIso,
    absoluteExpiresAt,
    inactivityLimitDays: INACTIVITY_LIMIT_DAYS,
  };
  const legacyDevice = {
    pk: `SITE#${siteId}`,
    sk: `DEVICE#${bindingId}`,
    type: "device",
    deviceId: bindingId,
    bindingId,
    physicalDeviceId,
    siteId,
    siteName: site.name,
    accessLevel,
    ...(accessLevel === "manager"
      ? { membershipId, membershipGeneration }
      : {}),
    siteCredentialGeneration: siteGeneration,
    label,
    status: "active",
    registeredAt: nowIso,
    lastSeenAt: nowIso,
    tokenGeneration: generation,
    refreshJti: refresh.jti,
    absoluteExpiresAt,
    inactivityLimitDays: INACTIVITY_LIMIT_DAYS,
  };
  const physicalWrite = physical
    ? {
        Update: {
          TableName: tableName,
          Key: { pk: physical.pk, sk: physical.sk },
          UpdateExpression:
            "SET lastEnrolledAt = :now, updatedAt = :now, label = :label",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":now": nowIso,
            ":label": label,
            ":revoked": "revoked",
          },
        },
      }
    : put(tableName, {
        pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
        sk: "#META",
        type: "physicalDevice",
        physicalDeviceId,
        label,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
        lastEnrolledAt: nowIso,
      });
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: grant.pk, sk: grant.sk },
              UpdateExpression:
                "SET #status = :redeemed, redeemedAt = :now, redeemedBindingId = :bindingId, redeemedPhysicalDeviceId = :physicalDeviceId",
              ConditionExpression:
                "#status = :pending AND expiresAt > :now AND tokenHash = :tokenHash",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":redeemed": "redeemed",
                ":now": nowIso,
                ":tokenHash": tokenHash,
                ":bindingId": bindingId,
                ":physicalDeviceId": physicalDeviceId,
              },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk: lookup.pk, sk: lookup.sk },
              UpdateExpression: "SET redeemedAt = :now, expiresAt = :retention",
              ConditionExpression:
                "grantId = :grantId AND attribute_not_exists(redeemedAt)",
              ExpressionAttributeValues: {
                ":grantId": grantId,
                ":now": nowIso,
                ":retention": Math.floor(now.getTime() / 1000) + 30 * 86400,
              },
            },
          },
          ...(accessLevel === "manager"
            ? [
                {
                  Delete: {
                    TableName: tableName,
                    Key: {
                      pk: `SITE#${siteId}`,
                      sk: `${grant.issuedBy === "manager-email-recovery" ? "MANAGER_RECOVERY_GRANT_CURRENT" : "MANAGER_GRANT_CURRENT"}#${membershipId}`,
                    },
                    ConditionExpression:
                      "attribute_not_exists(pk) OR grantId = :grantId",
                    ExpressionAttributeValues: { ":grantId": grantId },
                  },
                },
              ]
            : []),
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: authority.pk, sk: authority.sk },
              ConditionExpression:
                accessLevel === "manager"
                  ? "#status = :active AND generation = :generation"
                  : "#status = :active AND accessLevel = :manager",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ...(accessLevel === "manager"
                  ? { ":generation": membershipGeneration }
                  : {}),
                ...(accessLevel === "general" ? { ":manager": "manager" } : {}),
              },
            },
          },
          ...(accessLevel === "general"
            ? [
                {
                  ConditionCheck: {
                    TableName: tableName,
                    Key: {
                      pk: `SITE#${siteId}`,
                      sk: `MANAGER_MEMBERSHIP#${grant.issuerMembershipId}`,
                    },
                    ConditionExpression:
                      "#status = :active AND generation = :generation",
                    ExpressionAttributeNames: { "#status": "status" },
                    ExpressionAttributeValues: {
                      ":active": "active",
                      ":generation": Number(
                        grant.issuerMembershipGeneration ?? 0,
                      ),
                    },
                  },
                },
              ]
            : []),
          physicalWrite,
          put(tableName, binding),
          put(tableName, legacyDevice),
          put(tableName, {
            pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
            sk: `BINDING#${bindingId}`,
            type: "physicalDeviceBindingPointer",
            physicalDeviceId,
            bindingId,
            siteId,
            accessLevel,
            status: "active",
            createdAt: nowIso,
          }),
          put(tableName, {
            pk: `SITE#${siteId}`,
            sk: `AUDIT#${nowIso}#${randomUUID()}`,
            type: "siteAuditEvent",
            eventType: `${accessLevel}_grant_redeemed`,
            siteId,
            ...(membershipId ? { membershipId } : {}),
            grantId,
            bindingId,
            physicalDeviceId,
            actor: `physical-device:${physicalDeviceId}`,
            createdAt: nowIso,
          }),
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      return rejectEnrollment(event, "conflict", 409, grant, error);
    }
    throw error;
  }
  recordEnrollment(event, grant, physicalDeviceId);
  if (accessLevel === "manager") {
    await notifyManagerEnrollment({
      event,
      tableName,
      grant,
      membership: authority,
      site,
      label,
      enrolledAt: nowIso,
    });
  }
  return jsonResponse(201, {
    physicalDeviceId,
    bindingId,
    deviceId: bindingId,
    site: { siteId, name: site.name },
    accessLevel,
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: generation,
    absoluteExpiresAt,
    bindings: [
      {
        bindingId,
        siteId,
        siteName: site.name,
        accessLevel,
        status: "active",
      },
    ],
  });
};

/**
 * Redeem one provider-scoped grant into an all-or-nothing snapshot of the
 * Provider's active Sites. Each Site still receives an independent binding;
 * only the first binding gets an initial token pair. Other bindings are
 * activated through the existing binding-selection endpoint.
 * @param {{event:import("aws-lambda").APIGatewayProxyEventV2,input:Record<string,unknown>,grant:Record<string,any>,lookup:Record<string,any>,tokenHash:string,requestedPhysicalDeviceId:string,now:Date,nowIso:string,tableName:string}} context
 */
async function redeemProviderEnrollment(context) {
  const {
    event,
    input,
    grant,
    lookup,
    tokenHash,
    requestedPhysicalDeviceId,
    now,
    nowIso,
    tableName,
  } = context;
  const providerId = String(grant.providerId ?? "");
  const membershipId = String(grant.membershipId ?? "");
  const [providerResult, membershipResult, sitesResult, physicalResult] =
    await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
          ConsistentRead: true,
        }),
      ),
      findProviderManager(tableName, providerId, membershipId),
      queryProviderItems(tableName, providerId, "SITE#"),
      requestedPhysicalDeviceId
        ? ddb.send(
            new GetCommand({
              TableName: tableName,
              Key: {
                pk: `PHYSICAL_DEVICE#${requestedPhysicalDeviceId}`,
                sk: "#META",
              },
              ConsistentRead: true,
            }),
          )
        : Promise.resolve({}),
    ]);
  const provider = providerResult.Item;
  const membership = membershipResult;
  const physical = /** @type {any} */ (physicalResult).Item;
  const sites = (sitesResult.Items ?? [])
    .filter((site) => site.status !== "inactive")
    .sort((a, b) => String(a.siteId).localeCompare(String(b.siteId)));
  if (
    !provider ||
    provider.status === "inactive" ||
    !membership ||
    membership.status !== "active" ||
    Number(membership.generation ?? 0) !==
      Number(grant.membershipGeneration ?? -1) ||
    !sites.length ||
    sites.length > MAX_PROVIDER_ENROLLMENT_SITES ||
    physical?.status === "revoked"
  ) {
    return rejectEnrollment(event, "access_unavailable", 403, grant);
  }

  const label =
    clean(input.label).slice(0, 100) ||
    `${String(provider.name).slice(0, 75)} Manager device`;
  const physicalDeviceId = requestedPhysicalDeviceId || randomUUID();
  const absoluteExpiresAt = new Date(
    now.getTime() + ABSOLUTE_LIFETIME_MS,
  ).toISOString();
  const enrollmentId = randomUUID();
  const bindings = sites.map((site) => ({
    bindingId: randomUUID(),
    siteId: String(site.siteId),
    siteName: String(site.siteName ?? site.name),
    siteCredentialGeneration: Number(site.siteCredentialGeneration ?? 0),
    providerAccessGeneration: Number(site.providerAccessGeneration ?? 0),
  }));
  const initial = bindings[0];
  const [access, refresh] = await Promise.all([
    mintAccessToken(
      {
        siteId: initial.siteId,
        deviceId: initial.bindingId,
        tokenGeneration: 1,
        accessLevel: "manager",
      },
      { expiresIn: ACCESS_TTL_SECONDS },
    ),
    mintRefreshToken(
      {
        siteId: initial.siteId,
        deviceId: initial.bindingId,
        tokenGeneration: 1,
        accessLevel: "manager",
      },
      { expiresIn: REFRESH_TTL_SECONDS },
    ),
  ]);

  const physicalWrite = physical
    ? {
        Update: {
          TableName: tableName,
          Key: { pk: physical.pk, sk: physical.sk },
          UpdateExpression:
            "SET lastEnrolledAt = :now, updatedAt = :now, label = :label",
          ConditionExpression:
            "attribute_exists(pk) AND (attribute_not_exists(#status) OR #status <> :revoked)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":now": nowIso,
            ":label": label,
            ":revoked": "revoked",
          },
        },
      }
    : put(tableName, {
        pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
        sk: "#META",
        type: "physicalDevice",
        physicalDeviceId,
        label,
        status: "active",
        createdAt: nowIso,
        updatedAt: nowIso,
        lastEnrolledAt: nowIso,
      });

  const siteItems = bindings.flatMap((entry, index) => {
    const common = {
      bindingId: entry.bindingId,
      physicalDeviceId,
      siteId: entry.siteId,
      accessLevel: "manager",
      authorityScope: "provider",
      providerId,
      providerMembershipId: membershipId,
      providerMembershipGeneration: Number(membership.generation ?? 1),
      providerAccessGeneration: entry.providerAccessGeneration,
      providerEnrollmentId: enrollmentId,
      siteCredentialGeneration: entry.siteCredentialGeneration,
      label,
      status: "active",
      tokenGeneration: 1,
      refreshJti: index === 0 ? refresh.jti : "",
      enrolledAt: nowIso,
      enrolledByGrantId: grant.grantId,
      lastSeenAt: nowIso,
      absoluteExpiresAt,
      inactivityLimitDays: INACTIVITY_LIMIT_DAYS,
    };
    return [
      {
        ConditionCheck: {
          TableName: tableName,
          Key: { pk: `SITE#${entry.siteId}`, sk: "#META" },
          ConditionExpression:
            "#status = :active AND providerId = :providerId AND (providerAccessGeneration = :providerGeneration OR (attribute_not_exists(providerAccessGeneration) AND :providerGeneration = :zero)) AND (siteCredentialGeneration = :siteGeneration OR (attribute_not_exists(siteCredentialGeneration) AND :siteGeneration = :zero))",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":active": "active",
            ":providerId": providerId,
            ":siteGeneration": entry.siteCredentialGeneration,
            ":providerGeneration": entry.providerAccessGeneration,
            ":zero": 0,
          },
        },
      },
      put(tableName, {
        pk: `SITE#${entry.siteId}`,
        sk: `DEVICE_BINDING#${entry.bindingId}`,
        type: "deviceBinding",
        entityType: "DEVICE_BINDING",
        ...common,
      }),
      put(tableName, {
        pk: `SITE#${entry.siteId}`,
        sk: `DEVICE#${entry.bindingId}`,
        type: "device",
        deviceId: entry.bindingId,
        siteName: entry.siteName,
        registeredAt: nowIso,
        ...common,
      }),
      put(tableName, {
        pk: `PHYSICAL_DEVICE#${physicalDeviceId}`,
        sk: `BINDING#${entry.bindingId}`,
        type: "physicalDeviceBindingPointer",
        physicalDeviceId,
        bindingId: entry.bindingId,
        siteId: entry.siteId,
        accessLevel: "manager",
        status: "active",
        createdAt: nowIso,
      }),
    ];
  });

  const enrollment = {
    pk: `PROVIDER#${providerId}`,
    sk: `PROVIDER_MANAGER_ENROLLMENT#${enrollmentId}`,
    type: "providerManagerEnrollment",
    entityType: "PROVIDER_MANAGER_ENROLLMENT",
    enrollmentId,
    providerId,
    membershipId,
    membershipGeneration: Number(membership.generation ?? 1),
    physicalDeviceId,
    grantId: grant.grantId,
    status: "active",
    siteBindings: bindings.map((entry) => ({
      siteId: entry.siteId,
      siteName: entry.siteName,
      bindingId: entry.bindingId,
    })),
    siteCount: bindings.length,
    activeBindingCount: bindings.length,
    createdAt: nowIso,
  };
  try {
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: tableName,
              Key: { pk: grant.pk, sk: grant.sk },
              UpdateExpression:
                "SET #status = :redeemed, redeemedAt = :now, redeemedEnrollmentId = :enrollmentId, redeemedPhysicalDeviceId = :physicalDeviceId, redeemedSiteCount = :siteCount",
              ConditionExpression:
                "#status = :pending AND expiresAt > :now AND tokenHash = :tokenHash",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":pending": "pending",
                ":redeemed": "redeemed",
                ":now": nowIso,
                ":tokenHash": tokenHash,
                ":enrollmentId": enrollmentId,
                ":physicalDeviceId": physicalDeviceId,
                ":siteCount": bindings.length,
              },
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: { pk: lookup.pk, sk: lookup.sk },
              UpdateExpression: "SET redeemedAt = :now, expiresAt = :retention",
              ConditionExpression:
                "grantId = :grantId AND attribute_not_exists(redeemedAt)",
              ExpressionAttributeValues: {
                ":grantId": grant.grantId,
                ":now": nowIso,
                ":retention": Math.floor(now.getTime() / 1000) + 30 * 86400,
              },
            },
          },
          {
            Delete: {
              TableName: tableName,
              Key: {
                pk: `PROVIDER#${providerId}`,
                sk: `PROVIDER_MANAGER_GRANT_CURRENT#${membershipId}`,
              },
              ConditionExpression:
                "attribute_not_exists(pk) OR grantId = :grantId",
              ExpressionAttributeValues: { ":grantId": grant.grantId },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
              ConditionExpression: "#status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":active": "active" },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { pk: membership.pk, sk: membership.sk },
              ConditionExpression:
                "#status = :active AND generation = :generation",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":active": "active",
                ":generation": Number(membership.generation ?? 1),
              },
            },
          },
          physicalWrite,
          put(tableName, enrollment),
          put(tableName, {
            pk: `PROVIDER#${providerId}`,
            sk: `AUDIT#${nowIso}#${randomUUID()}`,
            type: "providerAuditEvent",
            eventType: "provider_manager_grant_redeemed",
            providerId,
            membershipId,
            grantId: grant.grantId,
            enrollmentId,
            physicalDeviceId,
            siteCount: bindings.length,
            siteIds: bindings.map((entry) => entry.siteId),
            actor: `physical-device:${physicalDeviceId}`,
            createdAt: nowIso,
          }),
          ...siteItems,
        ],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransactionCanceledException"
    ) {
      return rejectEnrollment(event, "conflict", 409, grant, error);
    }
    throw error;
  }

  recordEnrollment(event, grant, physicalDeviceId);
  await notifyProviderManagerEnrollment({
    event,
    tableName,
    grant,
    membership,
    provider,
    siteCount: bindings.length,
    label,
    enrolledAt: nowIso,
  });
  return jsonResponse(201, {
    physicalDeviceId,
    bindingId: initial.bindingId,
    deviceId: initial.bindingId,
    site: { siteId: initial.siteId, name: initial.siteName },
    provider: { providerId, name: provider.name },
    siteCount: bindings.length,
    accessLevel: "manager",
    token: access.token,
    refreshToken: refresh.token,
    expiresIn: access.expiresIn,
    refreshExpiresIn: refresh.expiresIn,
    tokenGeneration: 1,
    absoluteExpiresAt,
    bindings: bindings.map((entry) => ({
      bindingId: entry.bindingId,
      siteId: entry.siteId,
      siteName: entry.siteName,
      accessLevel: "manager",
      status: "active",
    })),
  });
}

/**
 * Notification failure must not roll back a successfully redeemed one-time
 * grant. Delivery evidence remains on the redeemed grant and safe logs feed
 * the operational alarm.
 * @param {{event:import("aws-lambda").APIGatewayProxyEventV2, tableName:string, grant:Record<string, any>, membership:Record<string, any>, site:Record<string, any>, label:string, enrolledAt:string}} input
 */
async function notifyManagerEnrollment(input) {
  let status = "accepted";
  let provider = process.env.EMAIL_TRANSPORT === "smtp" ? "smtp" : "ses";
  let messageId = "";
  try {
    const delivery = await sendManagerSecurityNotification({
      to: String(input.membership.email),
      managerName: String(input.membership.name || "Site Manager"),
      siteName: String(input.site.name),
      deviceLabel: input.label,
      clientDescription: describeClient(input.event.headers),
      enrolledAt: input.enrolledAt,
      revocationContact:
        process.env.SETUP_CODE_EMAIL_REPLY_TO ||
        process.env.SETUP_CODE_EMAIL_FROM,
    });
    provider = delivery.provider;
    messageId = delivery.messageId;
  } catch {
    status = "failed";
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: input.tableName,
        Key: { pk: input.grant.pk, sk: input.grant.sk },
        UpdateExpression:
          "SET securityNotificationStatus = :status, securityNotificationProvider = :provider, securityNotificationMessageId = :messageId, securityNotificationUpdatedAt = :now",
        ConditionExpression: "#status = :redeemed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":provider": provider,
          ":messageId": messageId,
          ":now": new Date().toISOString(),
          ":redeemed": "redeemed",
        },
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        marker: "ManagerSecurityNotificationEvidenceFailed",
        level: "ERROR",
      }),
    );
  }
  console[status === "failed" ? "error" : "info"](
    JSON.stringify({
      marker: "ManagerSecurityNotification",
      status,
      provider,
      siteId: String(input.site.siteId),
    }),
  );
}

/** @param {string} tableName @param {string} providerId @param {string} membershipId */
async function findProviderManager(tableName, providerId, membershipId) {
  const result = await queryProviderItems(
    tableName,
    providerId,
    "PROVIDER_MANAGER#",
  );
  return (result.Items ?? []).find(
    (item) => String(item.membershipId) === membershipId,
  );
}

/** @param {string} tableName @param {string} providerId @param {string} prefix */
async function queryProviderItems(tableName, providerId, prefix) {
  const Items = [];
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PROVIDER#${providerId}`,
          ":prefix": prefix,
        },
        ConsistentRead: true,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    Items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { Items };
}

/**
 * Provider-wide notification failure never rolls back valid bindings.
 * @param {{event:import("aws-lambda").APIGatewayProxyEventV2,tableName:string,grant:Record<string,any>,membership:Record<string,any>,provider:Record<string,any>,siteCount:number,label:string,enrolledAt:string}} input
 */
async function notifyProviderManagerEnrollment(input) {
  let status = "accepted";
  let provider = process.env.EMAIL_TRANSPORT === "smtp" ? "smtp" : "ses";
  let messageId = "";
  try {
    const delivery = await sendProviderManagerSecurityNotification({
      to: String(input.membership.email),
      managerName: String(input.membership.name || "Provider Manager"),
      providerName: String(input.provider.name),
      siteCount: input.siteCount,
      deviceLabel: input.label,
      clientDescription: describeClient(input.event.headers),
      enrolledAt: input.enrolledAt,
      revocationContact:
        process.env.SETUP_CODE_EMAIL_REPLY_TO ||
        process.env.SETUP_CODE_EMAIL_FROM,
    });
    provider = delivery.provider;
    messageId = delivery.messageId;
  } catch {
    status = "failed";
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: input.tableName,
        Key: { pk: input.grant.pk, sk: input.grant.sk },
        UpdateExpression:
          "SET securityNotificationStatus = :status, securityNotificationProvider = :provider, securityNotificationMessageId = :messageId, securityNotificationUpdatedAt = :now",
        ConditionExpression: "#status = :redeemed",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":provider": provider,
          ":messageId": messageId,
          ":now": new Date().toISOString(),
          ":redeemed": "redeemed",
        },
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        marker: "ProviderManagerSecurityNotificationEvidenceFailed",
        level: "ERROR",
      }),
    );
  }
  console[status === "failed" ? "error" : "info"](
    JSON.stringify({
      marker: "ProviderManagerSecurityNotification",
      status,
      provider,
      providerId: String(input.provider.providerId),
      siteCount: input.siteCount,
    }),
  );
}

/** @param {Record<string, string | undefined> | undefined} headers */
function describeClient(headers = {}) {
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "user-agent",
  );
  const userAgent = entry?.[1] ?? "";
  const platform = /android/i.test(userAgent)
    ? "Android"
    : /iphone|ipad|ipod/i.test(userAgent)
      ? "iOS/iPadOS"
      : /windows/i.test(userAgent)
        ? "Windows"
        : /cros/i.test(userAgent)
          ? "ChromeOS"
          : /macintosh|mac os/i.test(userAgent)
            ? "macOS"
            : /linux/i.test(userAgent)
              ? "Linux"
              : "unknown device";
  const browser = /edg\//i.test(userAgent)
    ? "Edge"
    : /firefox\//i.test(userAgent)
      ? "Firefox"
      : /chrome\//i.test(userAgent) || /crios\//i.test(userAgent)
        ? "Chrome"
        : /safari\//i.test(userAgent)
          ? "Safari"
          : "unknown browser";
  return `${browser} on ${platform}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return String(value ?? "").trim();
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function validDeviceId(value) {
  return /^[A-Za-z0-9_-]{8,100}$/.test(value);
}

/**
 * @param {string} tableName
 * @param {Record<string, unknown>} Item
 * @returns {Record<string, unknown>}
 */
function put(tableName, Item) {
  return {
    Put: {
      TableName: tableName,
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}

/**
 * Record only safe identifiers and reason codes, never request bodies or secrets.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {string} reason
 * @param {number} [status]
 * @param {Record<string, any>} [grant]
 * @param {Error} [error]
 */
function rejectEnrollment(event, reason, status = 401, grant, error) {
  const cancellationReasons =
    /** @type {{CancellationReasons?: Array<{Code?:string}>}|undefined} */ (
      error
    )?.CancellationReasons;
  console.info(
    JSON.stringify({
      marker: "EnrollmentRejected",
      requestId: event.requestContext?.requestId,
      grantId: grant?.grantId,
      scope: grant?.scope ?? (grant ? "site" : undefined),
      reason,
      cancellationCodes: cancellationReasons?.map((item) => item.Code),
    }),
  );
  return jsonResponse(status, {
    error: status === 401 ? INVALID_GRANT.error : `enrollment_${reason}`,
    requestId: event.requestContext?.requestId,
  });
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event @param {Record<string,any>} grant @param {string} physicalDeviceId */
function recordEnrollment(event, grant, physicalDeviceId) {
  console.info(
    JSON.stringify({
      marker: "EnrollmentRedeemed",
      requestId: event.requestContext?.requestId,
      grantId: grant.grantId,
      scope: grant.scope ?? "site",
      deliveryMode: grant.deliveryMode ?? "link",
      physicalDeviceId,
      client: describeClient(event.headers),
    }),
  );
}
