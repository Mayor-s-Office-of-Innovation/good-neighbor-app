import { managerSiteScope } from "../lib/manager-site-scope.js";
import { assignmentsMatchingEmail } from "../lib/manager-identity.js";
import { queryAllItems } from "../lib/query-all-items.js";
import { sitePrimaryContactChange } from "../lib/site-primary-contact.js";
import { staffRemovalContactGuard } from "../lib/staff-contact-guard.js";
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import {
  ADMIN_GROUPS,
  adminOnly,
  adminPrincipal,
  supervisorOnly,
  authorizeSiteChanges,
} from "../lib/admin-auth.js";
import { deactivateManagerMembershipRecord } from "./admin-manager-memberships.js";
import { emailHash, normalizeEmail } from "./setup-codes.js";

const SEARCH_PK = "PROGRAM_SEARCH#ACTIVE";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listPrograms = (event) =>
  adminOnly(event, async () => {
    const programs = await queryAll({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": SEARCH_PK },
    });
    return jsonResponse(200, { programs });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createProgram = (event) =>
  supervisorOnly(event, async (body) => {
    const name = clean(body.name);
    const providerId = clean(body.providerId);
    if (!name) return jsonResponse(400, { error: "name_required" });
    if (!providerId) return jsonResponse(400, { error: "provider_required" });
    let firstStaff =
      body.firstStaff === undefined ? null : normalizeContact(body.firstStaff);
    if (firstStaff) {
      if (!firstStaff.firstName || !firstStaff.lastName)
        return jsonResponse(400, { error: "name_required" });
      if (!isEmail(firstStaff.email))
        return jsonResponse(400, { error: "valid_email_required" });
    }
    const provider = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
      }),
    );
    if (!provider.Item || provider.Item.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    // Staff memberships are additive: selecting a source never moves or edits it.
    const sourceInput = body.existingStaff;
    const sourceChecks = [];
    let staffSource;
    if (sourceInput !== undefined) {
      if (firstStaff || !sourceInput || typeof sourceInput !== "object")
        return jsonResponse(400, { error: "invalid_staff_source" });
      const sourceRef = /** @type {Record<string, unknown>} */ (sourceInput);
      let sourceKey;
      if (
        sourceRef.providerManagerId &&
        !sourceRef.programId &&
        !sourceRef.userId
      ) {
        sourceKey = {
          pk: `PROVIDER#${providerId}`,
          sk: `PROVIDER_MANAGER#${clean(sourceRef.providerManagerId)}`,
        };
        staffSource = {
          providerId,
          providerManagerId: clean(sourceRef.providerManagerId),
        };
      } else if (
        sourceRef.programId &&
        sourceRef.userId &&
        !sourceRef.providerManagerId
      ) {
        const sourceProgramKey = {
          pk: `PROGRAM#${clean(sourceRef.programId)}`,
          sk: "#META",
        };
        const sourceProgram = await ddb.send(
          new GetCommand({
            TableName: getDynamoTableName(),
            Key: sourceProgramKey,
            ConsistentRead: true,
          }),
        );
        if (
          sourceProgram.Item?.providerId !== providerId ||
          sourceProgram.Item?.status !== "active"
        )
          return jsonResponse(400, { error: "invalid_staff_source" });
        sourceChecks.push({
          ConditionCheck: {
            TableName: getDynamoTableName(),
            Key: sourceProgramKey,
            ConditionExpression: "providerId = :provider AND #status = :active",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":provider": providerId,
              ":active": "active",
            },
          },
        });
        sourceKey = {
          pk: sourceProgramKey.pk,
          sk: `USER#${clean(sourceRef.userId)}`,
        };
        staffSource = {
          programId: clean(sourceRef.programId),
          userId: clean(sourceRef.userId),
        };
      } else return jsonResponse(400, { error: "invalid_staff_source" });
      const source = await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: sourceKey,
          ConsistentRead: true,
        }),
      );
      if (source.Item?.status !== "active")
        return jsonResponse(400, { error: "invalid_staff_source" });
      firstStaff = normalizeContact(source.Item);
      if (
        !firstStaff.firstName ||
        !firstStaff.lastName ||
        !isEmail(firstStaff.email)
      )
        return jsonResponse(400, { error: "invalid_staff_source" });
      sourceChecks.push({
        ConditionCheck: {
          TableName: getDynamoTableName(),
          Key: sourceKey,
          ConditionExpression:
            "#status = :active" +
            (source.Item.updatedAt
              ? " AND updatedAt = :version"
              : " AND attribute_not_exists(updatedAt)"),
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":active": "active",
            ...(source.Item.updatedAt
              ? { ":version": source.Item.updatedAt }
              : {}),
          },
        },
      });
    }
    const programId = slug(body.programId, `${providerId}-${name}`);
    const now = new Date().toISOString();
    const userId = firstStaff ? randomUUID() : null;
    const program = {
      ...(userId && body.contact === undefined
        ? { primaryContactUserId: userId }
        : {}),
      pk: `PROGRAM#${programId}`,
      sk: "#META",
      type: "program",
      entityType: "PROGRAM",
      programId,
      name,
      providerId,
      providerName: provider.Item.name,
      contact: normalizeContact(body.contact ?? firstStaff),
      status: "active",
      migrationPlaceholder: body.migrationPlaceholder === true,
      needsReview: body.needsReview === true,
      createdAt: now,
      updatedAt: now,
    };
    const user = firstStaff
      ? {
          pk: `PROGRAM#${programId}`,
          sk: `USER#${userId}`,
          type: "programUser",
          entityType: "PROGRAM_USER",
          programId,
          userId,
          ...firstStaff,
          ...(staffSource ? { staffSource } : {}),
          siteManager: false,
          status: "active",
          siteAssignmentCount: 0,
          createdAt: now,
          updatedAt: now,
        }
      : null;
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            ...sourceChecks,
            put(program),
            ...(user ? [put(user)] : []),
            put({
              pk: `PROVIDER#${providerId}`,
              sk: `PROGRAM#${programId}`,
              type: "providerProgramMembership",
              providerId,
              programId,
              programName: name,
              status: "active",
              createdAt: now,
              updatedAt: now,
            }),
            put({
              pk: SEARCH_PK,
              sk: `${name.toLocaleLowerCase("en-US")}#${programId}`,
              type: "programSearch",
              programId,
              name,
              providerId,
              providerName: provider.Item.name,
              migrationPlaceholder: program.migrationPlaceholder,
              needsReview: program.needsReview,
              updatedAt: now,
            }),
          ],
        }),
      );
    } catch (error) {
      const cancellation =
        /** @type {{ name?: string, CancellationReasons?: { Code?: string }[] }} */ (
          error
        );
      if (
        cancellation.name === "TransactionCanceledException" &&
        sourceChecks.some(
          (_, index) =>
            cancellation.CancellationReasons?.[index]?.Code ===
            "ConditionalCheckFailed",
        )
      ) {
        return jsonResponse(409, { error: "staff_source_changed" });
      }
      throw error;
    }
    return jsonResponse(201, { program, ...(user ? { user } : {}) });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getProgram = (event) =>
  adminOnly(event, async () => {
    const programId = event.pathParameters?.programId ?? "";
    const [program, sites, users] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
        }),
      ),
      queryChildren(programId, "SITE#"),
      queryChildren(programId, "USER#"),
    ]);
    if (!program.Item) return jsonResponse(404, { error: "not_found" });
    return jsonResponse(200, {
      program: program.Item,
      sites: sites.Items ?? [],
      users: users.Items ?? [],
    });
  });

/** Assign an existing Program to a provider when it has no active Site bindings. */
/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const assignProgramToProvider = (event) =>
  supervisorOnly(event, async (body) => {
    const providerId = event.pathParameters?.providerId ?? "";
    const programId = clean(body.programId);
    if (!programId) return jsonResponse(400, { error: "program_required" });
    const [providerResult, programResult, siteResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
        }),
      ),
      queryChildren(programId, "SITE#"),
    ]);
    const provider = providerResult.Item;
    const program = programResult.Item;
    if (!provider || provider.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    if (!program || program.status === "inactive") {
      return jsonResponse(404, { error: "program_not_found" });
    }
    if (program.providerId === providerId) {
      return jsonResponse(200, { program, unchanged: true });
    }
    if ((siteResult.Items || []).some((site) => site.status !== "inactive")) {
      return jsonResponse(409, { error: "program_has_sites" });
    }
    const now = new Date().toISOString();
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: getDynamoTableName(),
              Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
              UpdateExpression:
                "SET providerId = :providerId, providerName = :providerName, updatedAt = :now",
              ConditionExpression: "attribute_exists(pk) AND #status = :active",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":providerId": providerId,
                ":providerName": provider.name,
                ":now": now,
                ":active": "active",
              },
            },
          },
          put({
            pk: `PROVIDER#${providerId}`,
            sk: `PROGRAM#${programId}`,
            type: "providerProgramMembership",
            providerId,
            programId,
            programName: program.name,
            status: "active",
            createdAt: now,
            updatedAt: now,
          }),
          {
            Delete: {
              TableName: getDynamoTableName(),
              Key: {
                pk: `PROVIDER#${program.providerId}`,
                sk: `PROGRAM#${programId}`,
              },
            },
          },
          {
            Update: {
              TableName: getDynamoTableName(),
              Key: {
                pk: SEARCH_PK,
                sk: `${String(program.name).toLocaleLowerCase("en-US")}#${programId}`,
              },
              UpdateExpression:
                "SET providerId = :providerId, providerName = :providerName, updatedAt = :now",
              ExpressionAttributeValues: {
                ":providerId": providerId,
                ":providerName": provider.name,
                ":now": now,
              },
            },
          },
        ],
      }),
    );
    return jsonResponse(200, {
      program: {
        ...program,
        providerId,
        providerName: provider.name,
        updatedAt: now,
      },
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createProgramUser = (event) =>
  adminOnly(event, async (body) => {
    const programId = event.pathParameters?.programId ?? "";
    if (adminPrincipal(event).role !== ADMIN_GROUPS.supervisor) {
      const siteId = String(body.siteId || "");
      const denied = await authorizeSiteChanges(event, [siteId]);
      if (denied) return denied;
      const { Item: site } = await ddb.send(
        new GetCommand({
          TableName: getDynamoTableName(),
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          ConsistentRead: true,
        }),
      );
      if (
        !site ||
        site.status === "inactive" ||
        site.leadProgramId !== programId ||
        body.siteManager !== true ||
        body.isPrimaryContact !== undefined
      )
        return jsonResponse(403, { error: "site_assignment_required" });
    }
    const contact = normalizeContact(body);
    if (!contact.firstName || !contact.lastName) {
      return jsonResponse(400, { error: "name_required" });
    }
    if (!isEmail(contact.email)) {
      return jsonResponse(400, { error: "valid_email_required" });
    }
    if (!contact.phone) {
      return jsonResponse(400, { error: "phone_required" });
    }
    const program = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
      }),
    );
    if (!program.Item || program.Item.status === "inactive") {
      return jsonResponse(404, { error: "program_not_found" });
    }
    const userId = randomUUID();
    const now = new Date().toISOString();
    const user = {
      pk: `PROGRAM#${programId}`,
      sk: `USER#${userId}`,
      type: "programUser",
      entityType: "PROGRAM_USER",
      programId,
      userId,
      ...contact,
      siteManager: body.siteManager === true,
      status: "active",
      siteAssignmentCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [put(user)],
      }),
    );
    return jsonResponse(201, { user });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateProgramUser = (event) =>
  adminOnly(event, async (body) => {
    const programId = event.pathParameters?.programId ?? "";
    const userId = event.pathParameters?.userId ?? "";
    const contact = normalizeContact(body);
    if (!contact.firstName || !contact.lastName) {
      return jsonResponse(400, { error: "name_required" });
    }
    if (!isEmail(contact.email)) {
      return jsonResponse(400, { error: "valid_email_required" });
    }
    const current = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
      }),
    );
    if (!current.Item || current.Item.status !== "active") {
      return jsonResponse(404, { error: "program_user_not_found" });
    }
    if (current.Item.phone && !contact.phone) {
      return jsonResponse(400, { error: "phone_required" });
    }
    const principal = adminPrincipal(event);
    const requestedSiteManager = body.siteManager === true;
    if (
      principal.role !== ADMIN_GROUPS.supervisor &&
      (requestedSiteManager !== (current.Item.siteManager === true) ||
        contact.email !== normalizeEmail(String(current.Item.email ?? "")))
    ) {
      return jsonResponse(403, { error: "supervisor_required" });
    }
    if (principal.role !== ADMIN_GROUPS.supervisor) {
      if (body.isPrimaryContact !== undefined)
        return jsonResponse(403, { error: "supervisor_required" });
      const siteIds = await managerSiteScope(
        programId,
        userId,
        String(current.Item.email || ""),
      );
      const denied = await authorizeSiteChanges(event, siteIds);
      if (denied) return denied;
    }
    if (body.isPrimaryContact !== undefined) {
      if (typeof body.isPrimaryContact !== "boolean")
        return jsonResponse(400, { error: "invalid_primary_contact" });
      const tableName = getDynamoTableName();
      const { Item: program } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
          ConsistentRead: true,
        }),
      );
      if (!program || program.status === "inactive")
        return jsonResponse(404, { error: "program_not_found" });
      const wasPrimary = program.primaryContactUserId
        ? program.primaryContactUserId === userId
        : Boolean(
            program.contact?.email &&
              normalizeEmail(program.contact.email) ===
                normalizeEmail(current.Item.email),
          );
      const primaryId = body.isPrimaryContact
        ? userId
        : wasPrimary
          ? null
          : program.primaryContactUserId;
      const programContact = body.isPrimaryContact
        ? contact
        : wasPrimary
          ? {}
          : program.contact || {};
      const now = new Date().toISOString();
      const user = {
        ...current.Item,
        ...contact,
        siteManager: requestedSiteManager,
        updatedAt: now,
      };
      try {
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
                  UpdateExpression:
                    "SET firstName = :firstName, lastName = :lastName, phone = :phone, phoneExtension = :extension, email = :email, siteManager = :manager, updatedAt = :now",
                  ConditionExpression:
                    "attribute_exists(pk) AND #status = :active",
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":firstName": contact.firstName,
                    ":lastName": contact.lastName,
                    ":phone": contact.phone,
                    ":extension": contact.phoneExtension,
                    ":email": contact.email,
                    ":manager": requestedSiteManager,
                    ":now": now,
                    ":active": "active",
                  },
                },
              },
              {
                Update: {
                  TableName: tableName,
                  Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
                  UpdateExpression: `SET contact = :contact, updatedAt = :now${primaryId ? ", primaryContactUserId = :primary" : " REMOVE primaryContactUserId"}`,
                  ConditionExpression: `attribute_exists(pk) AND #status = :active AND ${program.updatedAt ? "updatedAt = :version" : "attribute_not_exists(updatedAt)"}`,
                  ExpressionAttributeNames: { "#status": "status" },
                  ExpressionAttributeValues: {
                    ":contact": programContact,
                    ":now": now,
                    ":active": "active",
                    ...(primaryId ? { ":primary": primaryId } : {}),
                    ...(program.updatedAt
                      ? { ":version": program.updatedAt }
                      : {}),
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "TransactionCanceledException"
        )
          return jsonResponse(409, { error: "program_staff_conflict" });
        throw error;
      }
      return jsonResponse(200, { user });
    }
    const now = new Date().toISOString();
    const result = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
        UpdateExpression:
          "SET firstName = :firstName, lastName = :lastName, phone = :phone, phoneExtension = :phoneExtension, email = :email, siteManager = :siteManager, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":firstName": contact.firstName,
          ":lastName": contact.lastName,
          ":phone": contact.phone,
          ":phoneExtension": contact.phoneExtension,
          ":email": contact.email,
          ":siteManager": requestedSiteManager,
          ":now": now,
          ":active": "active",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, { user: result.Attributes });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const deactivateProgramUser = (event) =>
  supervisorOnly(event, async () => {
    const programId = event.pathParameters?.programId ?? "";
    const userId = event.pathParameters?.userId ?? "";
    const tableName = getDynamoTableName();
    const current = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
      }),
    );
    if (!current.Item || current.Item.status === "inactive") {
      return jsonResponse(404, { error: "program_user_not_found" });
    }
    const guard = await staffRemovalContactGuard(
      tableName,
      programId,
      current.Item,
    );
    if (!guard.change) return jsonResponse(409, { error: guard.error });
    const removingManager = current.Item.siteManager === true;
    const now = new Date().toISOString();
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            guard.change,
            {
              Update: {
                TableName: tableName,
                Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
                UpdateExpression: "SET #status = :next, updatedAt = :now",
                ConditionExpression: `attribute_exists(pk) AND (#status = :active${removingManager ? " OR #status = :removing" : ""})${removingManager ? "" : " AND (attribute_not_exists(siteAssignmentCount) OR siteAssignmentCount = :zero)"}`,
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: {
                  ":next": removingManager ? "removing" : "inactive",
                  ":now": now,
                  ":active": "active",
                  ...(removingManager
                    ? { ":removing": "removing" }
                    : { ":zero": 0 }),
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      )
        return jsonResponse(409, { error: "program_user_in_use" });
      throw error;
    }
    if (removingManager)
      return removeSiteManager(event, programId, userId, current.Item);
    return jsonResponse(200, {
      user: { ...current.Item, status: "inactive", updatedAt: now },
    });
  });

/**
 * Remove a Site Manager after clearing every Site and app-access association.
 * Historical memberships and audit events remain archived for traceability.
 * @param {import("aws-lambda").APIGatewayProxyEventV2} event
 * @param {string} programId
 * @param {string} userId
 * @param {Record<string, any>} user
 */
async function removeSiteManager(event, programId, userId, user) {
  const tableName = getDynamoTableName();
  const verifier = await emailHash(String(user.email || ""));
  const [directoryResult, programSitesResult] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `MANAGER_EMAIL#${verifier}` },
      }),
    ),
    queryChildren(programId, "SITE#", true),
  ]);
  const actor = String(
    /** @type {any} */ (event.requestContext)?.authorizer?.jwt?.claims?.sub ??
      "central-admin",
  );
  const siteIds = new Set(
    (programSitesResult.Items ?? [])
      .map((site) => String(site.siteId || ""))
      .filter(Boolean),
  );
  let revokedBindingCount = 0;
  for (const directory of directoryResult.Items ?? []) {
    const siteId = String(directory.siteId || "");
    const membershipId = String(directory.membershipId || "");
    if (!siteId || !membershipId) continue;
    const membershipResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: {
          pk: `SITE#${siteId}`,
          sk: `MANAGER_MEMBERSHIP#${membershipId}`,
        },
      }),
    );
    const membership = membershipResult.Item;
    let belongsToManager = membership?.userId === userId;
    if (
      !membership?.userId &&
      String(membership?.email || "")
        .trim()
        .toLowerCase() ===
        String(user.email || "")
          .trim()
          .toLowerCase()
    ) {
      const assignments = await queryAllItems({
        TableName: tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": `SITE#${siteId}`,
          ":prefix": "ASSIGNED_USER#",
        },
        ConsistentRead: true,
      });
      const matches = await assignmentsMatchingEmail(
        tableName,
        assignments.Items,
        String(user.email || ""),
      );
      belongsToManager = matches.some(
        (row) => row.userId === userId && row.programId === programId,
      );
      if (belongsToManager && matches.length !== 1)
        return jsonResponse(409, { error: "ambiguous_manager_identity" });
    }
    if (!belongsToManager) continue;
    siteIds.add(siteId);
    const result = await deactivateManagerMembershipRecord({
      siteId,
      membershipId,
      actor,
      expectedUserId: userId,
    });
    if (result?.error) return jsonResponse(409, { error: result.error });
    revokedBindingCount += Number(result?.revokedBindingCount || 0);
  }

  let clearedSiteCount = 0;
  for (const siteId of siteIds) {
    const [siteResult, assignmentResult] = await Promise.all([
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: "#META" },
          ConsistentRead: true,
        }),
      ),
      ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
        }),
      ),
    ]);
    const site = siteResult.Item;
    const assignment = assignmentResult.Item;
    const isPrimary = site?.primaryContactUserId === userId;
    if (!assignment && !isPrimary) continue;
    const now = new Date().toISOString();
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [];
    if (assignment) {
      items.push({
        Delete: {
          TableName: tableName,
          Key: { pk: `SITE#${siteId}`, sk: `ASSIGNED_USER#${userId}` },
          ConditionExpression: "attribute_exists(pk)",
        },
      });
    }
    items.push(
      await sitePrimaryContactChange(tableName, siteId, now, {
        removeUserId: userId,
      }),
    );
    items.push(
      put({
        pk: `SITE#${siteId}`,
        sk: `AUDIT#${now}#${randomUUID()}`,
        type: "siteAuditEvent",
        eventType: "site_manager_removed",
        siteId,
        programId,
        userId,
        actor,
        createdAt: now,
      }),
    );
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
      clearedSiteCount += 1;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "manager_removal_conflict" });
      }
      throw error;
    }
  }

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { pk: `PROGRAM#${programId}`, sk: `USER#${userId}` },
        ConditionExpression: "attribute_exists(pk) AND siteManager = :true",
        ExpressionAttributeValues: { ":true": true },
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "ConditionalCheckFailedException"
    ) {
      return jsonResponse(409, { error: "manager_removal_conflict" });
    }
    throw error;
  }
  return jsonResponse(200, {
    removed: true,
    userId,
    clearedSiteCount,
    revokedBindingCount,
  });
}

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateProgram = (event) =>
  adminOnly(event, async (body) => {
    const programId = event.pathParameters?.programId ?? "";
    const name = clean(body.name);
    if (!name) return jsonResponse(400, { error: "name_required" });
    const tableName = getDynamoTableName();
    const currentResult = await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
        ConsistentRead: true,
      }),
    );
    const current = currentResult.Item;
    if (!current || current.status === "inactive") {
      return jsonResponse(404, { error: "program_not_found" });
    }
    const now = new Date().toISOString();
    const contact = normalizeContact(body.contact);
    const oldName = String(current.name ?? "");
    const oldSearchSk = programSearchSk(oldName, programId);
    const newSearchSk = programSearchSk(name, programId);
    /** @type {import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput["TransactItems"]} */
    const items = [
      {
        Update: {
          TableName: tableName,
          Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
          UpdateExpression:
            "SET #name = :name, contact = :contact, updatedAt = :now",
          ConditionExpression:
            "attribute_exists(pk) AND #status = :active AND #name = :oldName",
          ExpressionAttributeNames: { "#name": "name", "#status": "status" },
          ExpressionAttributeValues: {
            ":name": name,
            ":oldName": oldName,
            ":contact": contact,
            ":now": now,
            ":active": "active",
          },
        },
      },
      {
        Update: {
          TableName: tableName,
          Key: {
            pk: `PROVIDER#${String(current.providerId)}`,
            sk: `PROGRAM#${programId}`,
          },
          UpdateExpression: "SET programName = :name, updatedAt = :now",
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ":name": name, ":now": now },
        },
      },
    ];
    const searchItem = {
      pk: SEARCH_PK,
      sk: newSearchSk,
      type: "programSearch",
      programId,
      name,
      providerId: current.providerId,
      providerName: current.providerName,
      migrationPlaceholder: current.migrationPlaceholder === true,
      needsReview: current.needsReview === true,
      updatedAt: now,
    };
    if (oldSearchSk === newSearchSk) {
      items.push({
        Put: { TableName: tableName, Item: searchItem },
      });
    } else {
      items.push(
        {
          Delete: {
            TableName: tableName,
            Key: { pk: SEARCH_PK, sk: oldSearchSk },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: searchItem,
            ConditionExpression:
              "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        },
      );
    }
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        return jsonResponse(409, { error: "program_update_conflict" });
      }
      throw error;
    }
    return jsonResponse(200, {
      program: { ...current, name, contact, updatedAt: now },
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const deactivateProgram = (event) =>
  supervisorOnly(event, async () => {
    const programId = event.pathParameters?.programId ?? "";
    const now = new Date().toISOString();
    const current = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
      }),
    );
    if (!current.Item) return jsonResponse(404, { error: "not_found" });
    const result = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
        UpdateExpression: "SET #status = :inactive, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":inactive": "inactive", ":now": now },
        ReturnValues: "ALL_NEW",
      }),
    );
    await ddb.send(
      new DeleteCommand({
        TableName: getDynamoTableName(),
        Key: {
          pk: SEARCH_PK,
          sk: `${String(current.Item.name).toLocaleLowerCase("en-US")}#${programId}`,
        },
      }),
    );
    return jsonResponse(200, { program: result.Attributes });
  });

/** @param {string} programId @param {string} prefix @param {boolean} [consistentRead] */
async function queryChildren(programId, prefix, consistentRead = false) {
  const Items = await queryAll({
    TableName: getDynamoTableName(),
    ConsistentRead: consistentRead,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: {
      ":pk": `PROGRAM#${programId}`,
      ":prefix": prefix,
    },
  });
  return { Items };
}

/**
 * @param {import("@aws-sdk/lib-dynamodb").QueryCommandInput} input
 * @returns {Promise<Record<string, any>[]>}
 */
async function queryAll(input) {
  const items = [];
  let ExclusiveStartKey;
  do {
    /** @type {import("@aws-sdk/lib-dynamodb").QueryCommandOutput} */
    const page = await ddb.send(
      new QueryCommand({
        ...input,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** @param {string} name @param {string} programId */
function programSearchSk(name, programId) {
  return `${name.toLocaleLowerCase("en-US")}#${programId}`;
}

/** @param {Record<string, unknown>} Item */
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

/** @param {unknown} value */
function clean(value) {
  return String(value ?? "")
    .trim()
    .slice(0, 200);
}

/** @param {unknown} value */
function normalizeContact(value) {
  const contact = /** @type {Record<string, unknown>} */ (
    value && typeof value === "object" ? value : {}
  );
  return {
    firstName: clean(contact.firstName),
    lastName: clean(contact.lastName),
    phone: clean(contact.phone),
    phoneExtension: clean(contact.phoneExtension),
    email: clean(contact.email).toLocaleLowerCase("en-US"),
  };
}

/** @param {string} value @returns {boolean} */
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** @param {unknown} provided @param {string} fallback */
function slug(provided, fallback) {
  return (
    String(provided || fallback)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || randomUUID()
  );
}
