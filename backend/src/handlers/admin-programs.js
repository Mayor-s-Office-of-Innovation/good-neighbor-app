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
import { adminOnly } from "../lib/admin-auth.js";

const SEARCH_PK = "PROGRAM_SEARCH#ACTIVE";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listPrograms = (event) =>
  adminOnly(event, async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": SEARCH_PK },
        Limit: 100,
      }),
    );
    return jsonResponse(200, { programs: result.Items ?? [] });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createProgram = (event) =>
  adminOnly(event, async (body) => {
    const name = clean(body.name);
    const providerId = clean(body.providerId);
    if (!name) return jsonResponse(400, { error: "name_required" });
    if (!providerId) return jsonResponse(400, { error: "provider_required" });
    const provider = await ddb.send(
      new GetCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROVIDER#${providerId}`, sk: "#META" },
      }),
    );
    if (!provider.Item || provider.Item.status === "inactive") {
      return jsonResponse(404, { error: "provider_not_found" });
    }
    const programId = slug(body.programId, `${providerId}-${name}`);
    const now = new Date().toISOString();
    const program = {
      pk: `PROGRAM#${programId}`,
      sk: "#META",
      type: "program",
      entityType: "PROGRAM",
      programId,
      name,
      providerId,
      providerName: provider.Item.name,
      contact: normalizeContact(body.contact),
      status: "active",
      migrationPlaceholder: body.migrationPlaceholder === true,
      needsReview: body.needsReview === true,
      createdAt: now,
      updatedAt: now,
    };
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          put(program),
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
    return jsonResponse(201, { program });
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

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const updateProgram = (event) =>
  adminOnly(event, async (body) => {
    const programId = event.pathParameters?.programId ?? "";
    const name = clean(body.name);
    if (!name) return jsonResponse(400, { error: "name_required" });
    const now = new Date().toISOString();
    const result = await ddb.send(
      new UpdateCommand({
        TableName: getDynamoTableName(),
        Key: { pk: `PROGRAM#${programId}`, sk: "#META" },
        UpdateExpression:
          "SET #name = :name, contact = :contact, updatedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND #status = :active",
        ExpressionAttributeNames: { "#name": "name", "#status": "status" },
        ExpressionAttributeValues: {
          ":name": name,
          ":contact": normalizeContact(body.contact),
          ":now": now,
          ":active": "active",
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return jsonResponse(200, { program: result.Attributes });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const deactivateProgram = (event) =>
  adminOnly(event, async () => {
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

/** @param {string} programId @param {string} prefix */
function queryChildren(programId, prefix) {
  return ddb.send(
    new QueryCommand({
      TableName: getDynamoTableName(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `PROGRAM#${programId}`,
        ":prefix": prefix,
      },
    }),
  );
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
    email: clean(contact.email).toLocaleLowerCase("en-US"),
  };
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
