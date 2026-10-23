import {
  getPerson,
  personRecord,
  personPut,
  updatePersonRecord,
} from "../lib/people.js";
import {
  generateEnrollmentCode,
  enrollmentCodeVerifier,
} from "./enrollment-codes.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { URLSearchParams } from "node:url";
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { sendProviderManagerEnrollmentEmail } from "../integrations/email.js";
import { supervisorOnly } from "../lib/admin-auth.js";

export const MAX_PROVIDER_ENROLLMENT_SITES = 21;
const GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listProviderManagers = (event) =>
  supervisorOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const [providerResult, managersResult, enrollmentsResult] =
      await Promise.all([
        get(providerKey(providerId, "#META")),
        query(providerId, "PROVIDER_MANAGER#"),
        query(providerId, "PROVIDER_MANAGER_ENROLLMENT#"),
      ]);
    if (!providerResult.Item) {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    const enrollments = await reconcileEnrollmentStatus(
      enrollmentsResult.Items ?? [],
      managersResult.Items ?? [],
    );
    const counts = new Map();
    for (const enrollment of enrollments) {
      if (enrollment.status === "revoked") continue;
      counts.set(
        enrollment.membershipId,
        Number(counts.get(enrollment.membershipId) ?? 0) + 1,
      );
    }
    return jsonResponse(200, {
      managers: (managersResult.Items ?? []).map((item) => ({
        ...publicManager(item),
        activeDeviceCount:
          item.status === "active"
            ? Number(counts.get(item.membershipId) ?? 0)
            : 0,
      })),
      enrollments: enrollments.map(publicEnrollment),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createProviderManager = (event) =>
  supervisorOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const input = managerInput(body);
    if (input.error) return jsonResponse(400, { error: input.error });
    const providerResult = await get(providerKey(providerId, "#META"));
    if (!providerResult.Item || providerResult.Item.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    const now = new Date().toISOString();
    const membershipId = randomUUID();
    /** @type {Record<string, any>} */
    const item = {
      pk: `PROVIDER#${providerId}`,
      sk: `PROVIDER_MANAGER#${membershipId}`,
      type: "providerManagerMembership",
      entityType: "PROVIDER_MANAGER_MEMBERSHIP",
      membershipId,
      managerId: membershipId,
      providerId,
      ...input.value,
      status: "active",
      generation: 1,
      createdAt: now,
      createdBy: actorId(event),
      updatedAt: now,
      updatedBy: actorId(event),
    };
    const existingPerson = body.personId
      ? await getPerson(String(body.personId))
      : null;
    if (
      body.personId &&
      (!existingPerson || existingPerson.status !== "active")
    )
      return jsonResponse(404, { error: "person_not_found" });
    if (existingPerson) {
      for (const source of existingPerson.sources.filter(
        (/** @type {{pk:string,sk:string}} */ source) =>
          source.pk === `PROVIDER#${providerId}` &&
          source.sk.startsWith("PROVIDER_MANAGER#"),
      )) {
        const current = await get(source);
        if (current.Item?.status === "active")
          return jsonResponse(409, {
            error: "provider_manager_already_assigned",
          });
      }
    }
    const person = existingPerson
      ? {
          ...existingPerson,
          sources: [...existingPerson.sources, { pk: item.pk, sk: item.sk }],
          revision: randomUUID(),
        }
      : personRecord(
          { ...input.value, primaryProviderId: providerId },
          membershipId,
          [{ pk: item.pk, sk: item.sk }],
        );
    item.personId = person.personId;
    if (existingPerson)
      Object.assign(item, {
        firstName: person.firstName,
        lastName: person.lastName,
        name: person.name,
        email: person.email,
        phone: person.phone,
        phoneExtension: person.phoneExtension,
      });
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            personPut(person, existingPerson?.revision),
            put(item),
            put(emailDirectory(item, now)),
            put(
              providerAudit(providerId, "provider_manager_created", now, {
                membershipId,
                actor: actorId(event),
              }),
            ),
          ],
        }),
      );
    } catch (error) {
      if (isConflict(error)) {
        return jsonResponse(409, { error: "provider_manager_conflict" });
      }
      throw error;
    }
    return jsonResponse(201, { manager: publicManager(item) });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateProviderManager = (event) =>
  supervisorOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const membershipId = event.pathParameters?.membershipId ?? "";
    const input = managerInput(body);
    if (input.error) return jsonResponse(400, { error: input.error });
    const manager = await findManager(providerId, membershipId);
    if (!manager) {
      return jsonResponse(404, { error: "provider_manager_not_found" });
    }
    if (manager.personId) {
      const person = await getPerson(manager.personId);
      if (!person) return jsonResponse(409, { error: "person_not_found" });
      await updatePersonRecord(person, input.value || {}, actorId(event));
      return jsonResponse(200, {
        manager: publicManager({ ...manager, ...input.value }),
      });
    }
    const now = new Date().toISOString();
    const updated = {
      ...manager,
      ...input.value,
      updatedAt: now,
      updatedBy: actorId(event),
    };
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [
      {
        Update: {
          TableName: getDynamoTableName(),
          Key: { pk: manager.pk, sk: manager.sk },
          UpdateExpression:
            "SET firstName = :firstName, lastName = :lastName, #name = :name, email = :email, phone = :phone, phoneExtension = :extension, updatedAt = :now, updatedBy = :actor",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#name": "name" },
          ExpressionAttributeValues: {
            ":firstName": updated.firstName,
            ":lastName": updated.lastName,
            ":name": updated.name,
            ":email": updated.email,
            ":phone": updated.phone,
            ":extension": updated.phoneExtension,
            ":now": now,
            ":actor": actorId(event),
          },
        },
      },
      put(
        providerAudit(providerId, "provider_manager_updated", now, {
          membershipId,
          actor: actorId(event),
        }),
      ),
    ];
    if (manager.email !== updated.email && manager.status === "active") {
      items.push(
        {
          Delete: {
            TableName: getDynamoTableName(),
            Key: providerManagerEmailKey(
              manager.email,
              providerId,
              membershipId,
            ),
          },
        },
        put(emailDirectory(updated, now)),
      );
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isConflict(error)) {
        return jsonResponse(409, { error: "provider_manager_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, { manager: publicManager(updated) });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const deactivateProviderManager = (event) =>
  supervisorOnly(event, async () =>
    setProviderManagerStatus(event, "inactive"),
  );

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const reinstateProviderManager = (event) =>
  supervisorOnly(event, async () => setProviderManagerStatus(event, "active"));

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listProviderManagerGrants = (event) =>
  supervisorOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const result = await query(providerId, "PROVIDER_MANAGER_GRANT#", false);
    const now = new Date().toISOString();
    return jsonResponse(200, {
      grants: (result.Items ?? []).map((item) => publicGrant(item, now)),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createProviderManagerGrant = (event) =>
  supervisorOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const membershipId = clean(body.membershipId);
    if (!membershipId) {
      return jsonResponse(400, { error: "provider_manager_required" });
    }
    const [providerResult, manager, sitesResult, currentResult] =
      await Promise.all([
        get(providerKey(providerId, "#META")),
        findManager(providerId, membershipId),
        query(providerId, "SITE#"),
        get(
          providerKey(
            providerId,
            `PROVIDER_MANAGER_GRANT_CURRENT#${membershipId}`,
          ),
          true,
        ),
      ]);
    if (!providerResult.Item || providerResult.Item.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    if (!manager || manager.status !== "active") {
      return jsonResponse(404, { error: "provider_manager_not_found" });
    }
    const activeSites = (sitesResult.Items ?? []).filter(
      (site) => site.status !== "inactive",
    );
    if (!activeSites.length) {
      return jsonResponse(409, { error: "provider_has_no_active_sites" });
    }
    if (activeSites.length > MAX_PROVIDER_ENROLLMENT_SITES) {
      return jsonResponse(409, {
        error: "provider_site_limit_exceeded",
        siteCount: activeSites.length,
        limit: MAX_PROVIDER_ENROLLMENT_SITES,
      });
    }
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString();
    const grantId = randomUUID();
    if (
      body.deliveryMode !== undefined &&
      body.deliveryMode !== "link" &&
      body.deliveryMode !== "code"
    ) {
      return jsonResponse(400, { error: "invalid_delivery_mode" });
    }
    const deliveryMode = body.deliveryMode === "code" ? "code" : "link";
    const token =
      deliveryMode === "code"
        ? await generateEnrollmentCode()
        : randomBytes(32).toString("base64url");
    const tokenHash =
      deliveryMode === "code"
        ? await enrollmentCodeVerifier(token)
        : createHash("sha256").update(token).digest("hex");
    const grant = {
      pk: `PROVIDER#${providerId}`,
      sk: `PROVIDER_MANAGER_GRANT#${nowIso}#${grantId}`,
      type: "providerManagerEnrollmentGrant",
      entityType: "PROVIDER_MANAGER_ENROLLMENT_GRANT",
      scope: "provider",
      grantId,
      providerId,
      providerName: providerResult.Item.name,
      membershipId,
      membershipGeneration: Number(manager.generation ?? 1),
      accessLevel: "manager",
      tokenHash,
      deliveryMode,
      status: "pending",
      deliveryStatus: "queued",
      issuedTo: manager.email,
      issuedBy: actorId(event),
      siteCountAtIssue: activeSites.length,
      createdAt: nowIso,
      expiresAt,
    };
    const current = currentResult.Item;
    if (current && current.expiresAt > nowIso) {
      return jsonResponse(409, {
        error: "provider_manager_grant_already_active",
      });
    }
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [
      put(grant),
      put({
        pk: `ENROLLMENT_TOKEN#${tokenHash}`,
        sk: "#META",
        type: "enrollmentGrantToken",
        scope: "provider",
        grantPk: grant.pk,
        grantSk: grant.sk,
        grantId,
        providerId,
        expiresAt,
      }),
      {
        Put: {
          TableName: getDynamoTableName(),
          Item: {
            pk: `PROVIDER#${providerId}`,
            sk: `PROVIDER_MANAGER_GRANT_CURRENT#${membershipId}`,
            type: "currentProviderManagerEnrollmentGrant",
            providerId,
            membershipId,
            grantId,
            grantPk: grant.pk,
            grantSk: grant.sk,
            tokenHash,
            expiresAt,
            updatedAt: nowIso,
          },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
          ExpressionAttributeValues: { ":now": nowIso },
        },
      },
      put(
        providerAudit(providerId, "provider_manager_grant_issued", nowIso, {
          membershipId,
          grantId,
          siteCount: activeSites.length,
          actor: actorId(event),
        }),
      ),
    ];
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (isConflict(error)) {
        return jsonResponse(409, { error: "provider_manager_grant_conflict" });
      }
      throw error;
    }
    const enrollmentUrl =
      deliveryMode === "code"
        ? new URL(
            "#login=1",
            process.env.PROVIDER_APP_URL ?? "http://localhost:5173/",
          ).toString()
        : enrollmentLink(
            process.env.PROVIDER_APP_URL ?? "http://localhost:5173/",
            grantId,
            token,
          );
    let deliveryStatus = "accepted";
    let deliveryProvider = configuredDeliveryProvider();
    let messageId = "";
    try {
      const delivery = await sendProviderManagerEnrollmentEmail({
        to: String(manager.email),
        managerName: String(manager.name),
        providerName: String(providerResult.Item.name),
        siteCount: activeSites.length,
        enrollmentUrl,
        ...(deliveryMode === "code" ? { enrollmentCode: token } : {}),
        expiresAt,
      });
      deliveryProvider = delivery.provider;
      messageId = delivery.messageId;
    } catch {
      deliveryStatus = "failed";
    }
    await updateDelivery(grant, deliveryStatus, deliveryProvider, messageId);
    return jsonResponse(201, {
      grant: publicGrant(
        { ...grant, deliveryStatus, deliveryProvider },
        nowIso,
      ),
      enrollmentUrl,
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const cancelProviderManagerGrant = (event) =>
  supervisorOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const grantId = event.pathParameters?.grantId ?? "";
    const grants = await query(providerId, "PROVIDER_MANAGER_GRANT#");
    const grant = (grants.Items ?? []).find(
      (item) => item.grantId === grantId && item.status === "pending",
    );
    if (!grant) {
      return jsonResponse(404, { error: "provider_manager_grant_not_found" });
    }
    const now = new Date().toISOString();
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: getDynamoTableName(),
                Key: { pk: grant.pk, sk: grant.sk },
                UpdateExpression:
                  "SET #status = :cancelled, cancelledAt = :now, cancelledBy = :actor",
                ConditionExpression: "#status = :pending",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":pending": "pending",
                  ":cancelled": "cancelled",
                  ":now": now,
                  ":actor": actorId(event),
                },
              },
            },
            {
              Delete: {
                TableName: getDynamoTableName(),
                Key: { pk: `ENROLLMENT_TOKEN#${grant.tokenHash}`, sk: "#META" },
              },
            },
            {
              Delete: {
                TableName: getDynamoTableName(),
                Key: providerKey(
                  providerId,
                  `PROVIDER_MANAGER_GRANT_CURRENT#${grant.membershipId}`,
                ),
                ConditionExpression:
                  "attribute_not_exists(pk) OR grantId = :grantId",
                ExpressionAttributeValues: { ":grantId": grantId },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConflict(error)) {
        return jsonResponse(409, { error: "provider_manager_grant_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, { cancelled: true, grantId });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const revokeProviderManagerEnrollment = (event) =>
  supervisorOnly(event, async () => {
    const providerId = event.pathParameters?.providerId ?? "";
    const enrollmentId = event.pathParameters?.enrollmentId ?? "";
    const enrollment = (
      await get(
        providerKey(providerId, `PROVIDER_MANAGER_ENROLLMENT#${enrollmentId}`),
        true,
      )
    ).Item;
    if (!enrollment || enrollment.status !== "active") {
      return jsonResponse(404, {
        error: "provider_manager_enrollment_not_found",
      });
    }
    const bindings = Array.isArray(enrollment.siteBindings)
      ? enrollment.siteBindings
      : [];
    if (bindings.length > MAX_PROVIDER_ENROLLMENT_SITES) {
      return jsonResponse(409, { error: "provider_site_limit_exceeded" });
    }
    const now = new Date().toISOString();
    const actor = actorId(event);
    const currentBindings = await Promise.all(
      bindings.map((binding) =>
        get(
          {
            pk: `SITE#${binding.siteId}`,
            sk: `DEVICE_BINDING#${binding.bindingId}`,
          },
          true,
        ),
      ),
    );
    const activeBindings = bindings.filter(
      (_binding, index) => currentBindings[index].Item?.status === "active",
    );
    const updates = activeBindings.flatMap((binding) => [
      revokeBinding(
        `SITE#${binding.siteId}`,
        `DEVICE_BINDING#${binding.bindingId}`,
        now,
        actor,
      ),
      revokeBinding(
        `SITE#${binding.siteId}`,
        `DEVICE#${binding.bindingId}`,
        now,
        actor,
      ),
      {
        Update: {
          TableName: getDynamoTableName(),
          Key: {
            pk: `PHYSICAL_DEVICE#${enrollment.physicalDeviceId}`,
            sk: `BINDING#${binding.bindingId}`,
          },
          UpdateExpression:
            "SET #status = :revoked, revokedAt = :now, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":revoked": "revoked", ":now": now },
        },
      },
    ]);
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: getDynamoTableName(),
                Key: { pk: enrollment.pk, sk: enrollment.sk },
                UpdateExpression:
                  "SET #status = :revoked, revokedAt = :now, revokedBy = :actor",
                ConditionExpression: "#status = :active",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":active": "active",
                  ":revoked": "revoked",
                  ":now": now,
                  ":actor": actor,
                },
              },
            },
            put(
              providerAudit(
                providerId,
                "provider_manager_enrollment_revoked",
                now,
                {
                  membershipId: enrollment.membershipId,
                  enrollmentId,
                  physicalDeviceId: enrollment.physicalDeviceId,
                  siteCount: bindings.length,
                  actor,
                },
              ),
            ),
            ...updates,
          ],
        }),
      );
    } catch (error) {
      if (isConflict(error)) {
        return jsonResponse(409, {
          error: "provider_manager_enrollment_conflict",
        });
      }
      throw error;
    }
    return jsonResponse(200, {
      revoked: true,
      enrollmentId,
      revokedBindingCount: activeBindings.length,
    });
  });

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event @param {"active"|"inactive"} status */
async function setProviderManagerStatus(event, status) {
  const providerId = event.pathParameters?.providerId ?? "";
  const membershipId = event.pathParameters?.membershipId ?? "";
  const manager = await findManager(providerId, membershipId);
  if (!manager) {
    return jsonResponse(404, { error: "provider_manager_not_found" });
  }
  if (manager.status === status) {
    return jsonResponse(200, {
      manager: publicManager(manager),
      unchanged: true,
    });
  }
  const now = new Date().toISOString();
  const expression =
    status === "inactive"
      ? "SET #status = :status, generation = generation + :one, deactivatedAt = :now, updatedAt = :now, updatedBy = :actor"
      : "SET #status = :status, reinstatedAt = :now, updatedAt = :now, updatedBy = :actor REMOVE deactivatedAt";
  /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
  const items = [
    {
      Update: {
        TableName: getDynamoTableName(),
        Key: { pk: manager.pk, sk: manager.sk },
        UpdateExpression: expression,
        ConditionExpression: "#status = :expected",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":expected": status === "inactive" ? "active" : "inactive",
          ...(status === "inactive" ? { ":one": 1 } : {}),
          ":now": now,
          ":actor": actorId(event),
        },
      },
    },
    put(
      providerAudit(
        providerId,
        status === "inactive"
          ? "provider_manager_deactivated"
          : "provider_manager_reinstated",
        now,
        { membershipId, actor: actorId(event) },
      ),
    ),
  ];
  if (status === "inactive") {
    items.push({
      Delete: {
        TableName: getDynamoTableName(),
        Key: providerManagerEmailKey(manager.email, providerId, membershipId),
      },
    });
  } else {
    items.push(put(emailDirectory({ ...manager, status }, now)));
  }
  try {
    await ddb.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (isConflict(error)) {
      return jsonResponse(409, { error: "provider_manager_conflict" });
    }
    throw error;
  }
  return jsonResponse(200, {
    manager: publicManager({
      ...manager,
      status,
      generation:
        status === "inactive"
          ? Number(manager.generation ?? 1) + 1
          : manager.generation,
      updatedAt: now,
    }),
  });
}

function configuredDeliveryProvider() {
  return process.env.EMAIL_TRANSPORT === "smtp" ? "smtp" : "ses";
}

/** @param {string} providerId @param {string} membershipId */
async function findManager(providerId, membershipId) {
  const result = await query(providerId, "PROVIDER_MANAGER#");
  return (result.Items ?? []).find(
    (item) => String(item.membershipId) === membershipId,
  );
}

/** @param {Record<string, unknown>} body */
function managerInput(body) {
  const firstName = clean(body.firstName);
  const lastName = clean(body.lastName);
  const email = clean(body.email).toLocaleLowerCase("en-US");
  const phone = clean(body.phone);
  if (
    !firstName ||
    !lastName ||
    firstName.length > 100 ||
    lastName.length > 100
  ) {
    return { error: "provider_manager_name_required" };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return { error: "provider_manager_email_invalid" };
  }
  if (!phone || phone.length > 40) {
    return { error: "provider_manager_phone_required" };
  }
  return {
    value: {
      firstName,
      lastName,
      name: `${firstName} ${lastName}`,
      email,
      phone,
      phoneExtension: clean(body.phoneExtension).slice(0, 20),
    },
  };
}

/** @param {Record<string, any>} item */
function publicManager(item) {
  return {
    personId: item.personId,
    membershipId: item.membershipId,
    providerId: item.providerId,
    firstName: item.firstName,
    lastName: item.lastName,
    name: item.name,
    email: item.email,
    phone: item.phone,
    phoneExtension: item.phoneExtension,
    status: item.status,
    generation: Number(item.generation ?? 1),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** @param {Record<string, any>} item @param {string} now */
function publicGrant(item, now) {
  return {
    deliveryMode: item.deliveryMode ?? "link",
    grantId: item.grantId,
    membershipId: item.membershipId,
    providerId: item.providerId,
    providerName: item.providerName,
    siteCount: item.redeemedSiteCount ?? item.siteCountAtIssue,
    status:
      item.status === "pending" && item.expiresAt <= now
        ? "expired"
        : item.status,
    deliveryStatus: item.deliveryStatus,
    deliveryProvider: item.deliveryProvider,
    securityNotificationStatus: item.securityNotificationStatus,
    issuedTo: item.issuedTo,
    issuedBy: item.issuedBy,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

/** @param {Record<string, any>} item */
function publicEnrollment(item) {
  return {
    enrollmentId: item.enrollmentId,
    membershipId: item.membershipId,
    physicalDeviceId: item.physicalDeviceId,
    status: item.status,
    siteCount: item.siteCount,
    activeSiteCount:
      item.status === "revoked"
        ? 0
        : Number(item.activeBindingCount ?? item.siteCount ?? 0),
    createdAt: item.createdAt,
  };
}

/** @param {string} pk @param {string} sk @param {string} now @param {string} actor */
function revokeBinding(pk, sk, now, actor) {
  return {
    Update: {
      TableName: getDynamoTableName(),
      Key: { pk, sk },
      UpdateExpression:
        "SET #status = :revoked, revokedAt = :now, updatedAt = :now, revokedReason = :reason, revokedBy = :actor ADD tokenGeneration :one",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":now": now,
        ":reason": "provider_manager_enrollment_revoked",
        ":actor": actor,
        ":one": 1,
      },
    },
  };
}

/** @param {Record<string, any>} manager @param {string} now */
function emailDirectory(manager, now) {
  return {
    ...providerManagerEmailKey(
      manager.email,
      manager.providerId,
      manager.membershipId,
    ),
    type: "providerManagerEmailDirectory",
    membershipId: manager.membershipId,
    managerId: manager.managerId ?? manager.membershipId,
    providerId: manager.providerId,
    status: manager.status,
    createdAt: now,
  };
}

/** @param {string} email @param {string} providerId @param {string} membershipId */
function providerManagerEmailKey(email, providerId, membershipId) {
  return {
    pk: `PROVIDER_MANAGER_EMAIL#${stableId(email)}`,
    sk: `PROVIDER#${providerId}#MEMBERSHIP#${membershipId}`,
  };
}

/** @param {string} providerId @param {string} eventType @param {string} createdAt @param {Record<string, unknown>} detail */
function providerAudit(providerId, eventType, createdAt, detail) {
  return {
    pk: `PROVIDER#${providerId}`,
    sk: `AUDIT#${createdAt}#${randomUUID()}`,
    type: "providerAuditEvent",
    providerId,
    eventType,
    createdAt,
    ...detail,
  };
}

/** @param {Record<string, any>} grant @param {string} status @param {string} provider @param {string} messageId */
async function updateDelivery(grant, status, provider, messageId) {
  await ddb.send(
    new UpdateCommand({
      TableName: getDynamoTableName(),
      Key: { pk: grant.pk, sk: grant.sk },
      UpdateExpression:
        "SET deliveryStatus = :status, deliveryProvider = :provider, deliveryMessageId = :messageId, deliveryUpdatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":status": status,
        ":provider": provider,
        ":messageId": messageId,
        ":now": new Date().toISOString(),
      },
    }),
  );
}

/** @param {string} appUrl @param {string} grantId @param {string} token */
function enrollmentLink(appUrl, grantId, token) {
  const url = new URL(appUrl);
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("enrollment_grant", grantId);
  fragment.set("enrollment_token", token);
  url.hash = fragment.toString();
  return url.toString();
}

/** @param {string} providerId @param {string} sk */
function providerKey(providerId, sk) {
  return { pk: `PROVIDER#${providerId}`, sk };
}

/** @param {{pk:string,sk:string}} Key @param {boolean} [ConsistentRead] */
function get(Key, ConsistentRead = false) {
  return ddb.send(
    new GetCommand({
      TableName: getDynamoTableName(),
      Key,
      ConsistentRead,
    }),
  );
}

/** @param {string} providerId @param {string} prefix @param {boolean} [ascending] */
async function query(providerId, prefix, ascending = true) {
  const Items = [];
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `PROVIDER#${providerId}`,
          ":prefix": prefix,
        },
        ScanIndexForward: ascending,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    Items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { Items };
}

/**
 * Resolve enrollment display state from authoritative physical and binding rows.
 * @param {Array<Record<string, any>>} enrollments
 * @param {Array<Record<string, any>>} managers
 */
async function reconcileEnrollmentStatus(enrollments, managers) {
  const candidates = enrollments.filter((item) => item.status !== "revoked");
  /** @type {Array<Record<string, any>>} */
  const requestedKeys = candidates.flatMap((item) => [
    { pk: `PHYSICAL_DEVICE#${item.physicalDeviceId}`, sk: "#META" },
    ...(Array.isArray(item.siteBindings)
      ? item.siteBindings.map((binding) => ({
          pk: `SITE#${binding.siteId}`,
          sk: `DEVICE_BINDING#${binding.bindingId}`,
        }))
      : []),
  ]);
  const keys = [
    ...new Map(
      requestedKeys.map((key) => [`${key.pk}|${key.sk}`, key]),
    ).values(),
  ];
  /** @type {Map<string, Record<string, any>>} */
  const records = new Map();
  for (let offset = 0; offset < keys.length; offset += 100) {
    /** @type {Array<Record<string, any>>} */
    let pending = keys.slice(offset, offset + 100);
    let attempts = 0;
    do {
      attempts += 1;
      const result = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [getDynamoTableName()]: { Keys: pending, ConsistentRead: true },
          },
        }),
      );
      for (const item of result.Responses?.[getDynamoTableName()] ?? []) {
        records.set(`${item.pk}|${item.sk}`, item);
      }
      pending = result.UnprocessedKeys?.[getDynamoTableName()]?.Keys ?? [];
      if (pending.length && attempts >= 3) {
        throw new Error("provider_enrollment_state_unavailable");
      }
    } while (pending.length);
  }
  return enrollments.map((item) => {
    if (item.status === "revoked") return item;
    const manager = managers.find(
      (row) => row.membershipId === item.membershipId,
    );
    if (manager && manager.status !== "active")
      return { ...item, status: "revoked", activeBindingCount: 0 };
    const physical = records.get(
      `PHYSICAL_DEVICE#${item.physicalDeviceId}|#META`,
    );
    const bindings = Array.isArray(item.siteBindings) ? item.siteBindings : [];
    const liveBindingCount = bindings.filter(
      (binding) =>
        records.get(
          `SITE#${binding.siteId}|DEVICE_BINDING#${binding.bindingId}`,
        )?.status === "active",
    ).length;
    const activeBindingCount =
      physical?.status === "active" ? liveBindingCount : 0;
    const status =
      activeBindingCount === 0
        ? "revoked"
        : activeBindingCount < bindings.length
          ? "partially_revoked"
          : "active";
    return { ...item, status, activeBindingCount };
  });
}

/** @param {Record<string, any>} Item */
function put(Item) {
  return {
    Put: {
      TableName: getDynamoTableName(),
      Item,
      ConditionExpression:
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    },
  };
}

/** @param {string} value */
function stableId(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** @param {unknown} value */
function clean(value) {
  return String(value ?? "").trim();
}

/** @param {import("aws-lambda").APIGatewayProxyEventV2} event */
function actorId(event) {
  return String(
    /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
      /** @type {any} */ (event.requestContext)?.authorizer?.["claims.sub"] ??
      "compliance-supervisor",
  );
}

/** @param {unknown} error */
function isConflict(error) {
  return (
    error instanceof Error && error.name === "TransactionCanceledException"
  );
}

/** Transfer authority, never the old device bindings. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const transferProviderManager = (event) =>
  supervisorOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId || "";
    const manager = await findManager(
      providerId,
      event.pathParameters?.membershipId || "",
    );
    const targetId = clean(body.providerId);
    if (!manager || manager.status !== "active")
      return jsonResponse(404, { error: "provider_manager_not_found" });
    if (!targetId || targetId === providerId)
      return jsonResponse(400, { error: "different_provider_required" });
    const target = await get(providerKey(targetId, "#META"));
    if (!target.Item || target.Item.status !== "active")
      return jsonResponse(404, { error: "provider_not_found" });
    const person = await getPerson(manager.personId);
    if (!person)
      return jsonResponse(409, { error: "person_migration_required" });
    for (const source of person.sources.filter(
      (/** @type {{pk:string,sk:string}} */ source) =>
        source.pk === `PROVIDER#${targetId}` &&
        source.sk.startsWith("PROVIDER_MANAGER#"),
    )) {
      const existing = await get(source);
      if (existing.Item?.status === "active")
        return jsonResponse(409, {
          error: "provider_manager_already_assigned",
        });
    }
    const now = new Date().toISOString();
    const membershipId = randomUUID();
    const next = {
      ...manager,
      pk: `PROVIDER#${targetId}`,
      sk: `PROVIDER_MANAGER#${membershipId}`,
      providerId: targetId,
      membershipId,
      managerId: membershipId,
      generation: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: actorId(event),
      updatedBy: actorId(event),
    };
    const old = {
      ...manager,
      status: "inactive",
      generation: Number(manager.generation || 1) + 1,
      deactivatedAt: now,
      updatedAt: now,
      transferredTo: { providerId: targetId, membershipId },
    };
    const changedPerson = {
      ...person,
      primaryProviderId: targetId,
      sources: [...person.sources, { pk: next.pk, sk: next.sk }],
      revision: randomUUID(),
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: getDynamoTableName(),
                Key: providerKey(targetId, "#META"),
                ConditionExpression: "#status = :active",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":active": "active" },
              },
            },
            personPut(changedPerson, person.revision),
            {
              Put: {
                TableName: getDynamoTableName(),
                Item: old,
                ConditionExpression:
                  manager.generation === undefined
                    ? "#status = :active AND attribute_not_exists(generation)"
                    : "#status = :active AND generation = :generation",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":active": "active",
                  ...(manager.generation === undefined
                    ? {}
                    : { ":generation": manager.generation }),
                },
              },
            },
            put(next),
            put(emailDirectory(next, now)),
            {
              Delete: {
                TableName: getDynamoTableName(),
                Key: providerManagerEmailKey(
                  manager.email,
                  providerId,
                  manager.membershipId,
                ),
              },
            },
            put(
              providerAudit(providerId, "provider_manager_transferred", now, {
                membershipId: manager.membershipId,
                targetProviderId: targetId,
                newMembershipId: membershipId,
                actor: actorId(event),
              }),
            ),
            put(
              providerAudit(targetId, "provider_manager_transferred_in", now, {
                membershipId,
                sourceProviderId: providerId,
                actor: actorId(event),
              }),
            ),
          ],
        }),
      );
    } catch (error) {
      if (isConflict(error))
        return jsonResponse(409, { error: "provider_manager_conflict" });
      throw error;
    }
    return jsonResponse(200, { manager: publicManager(next) });
  });
