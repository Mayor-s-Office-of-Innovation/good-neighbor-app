import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getDynamoTableName } from "../config.js";
import { ddb } from "../db.js";
import { jsonResponse } from "../http.js";
import { adminOnly } from "../lib/admin-auth.js";

const DIRECTORY_PK = "ADMIN_DIRECTORY#OVERSIGHT";
const DEFAULT_DEPARTMENTS = ["DPH", "HSH"];
const DEFAULT_SYSTEMS_OF_CARE = ["BHS-PBH"];

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const listOversightOptions = (event) =>
  adminOnly(event, async () => {
    const result = await ddb.send(
      new QueryCommand({
        TableName: getDynamoTableName(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": DIRECTORY_PK },
      }),
    );
    const items = result.Items || [];
    return jsonResponse(200, {
      departments: mergeDefaults(
        DEFAULT_DEPARTMENTS,
        items.filter((item) => item.optionType === "department"),
        "department",
      ),
      systemsOfCare: mergeDefaults(
        DEFAULT_SYSTEMS_OF_CARE,
        items.filter((item) => item.optionType === "systemOfCare"),
        "systemOfCare",
      ),
    });
  });

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const createOversightOption = (event) =>
  adminOnly(event, async (body) => {
    const type = String(body.type || "").trim();
    const name = String(body.name || "")
      .trim()
      .slice(0, 120);
    if (!new Set(["department", "systemOfCare"]).has(type)) {
      return jsonResponse(400, { error: "invalid_oversight_option_type" });
    }
    if (!name) return jsonResponse(400, { error: "name_required" });
    const now = new Date().toISOString();
    const item = {
      pk: DIRECTORY_PK,
      sk: `${type.toUpperCase()}#${normalizeKey(name)}`,
      type: "oversightDirectoryOption",
      optionType: type,
      name,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return jsonResponse(201, { option: publicOption(item) });
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        return jsonResponse(409, { error: "oversight_option_exists" });
      }
      throw error;
    }
  });

/**
 * @param {string[]} defaults
 * @param {Record<string, any>[]} items
 * @param {"department" | "systemOfCare"} type
 */
function mergeDefaults(defaults, items, type) {
  const merged = new Map(
    defaults.map((name) => [name.toLocaleLowerCase("en-US"), { type, name }]),
  );
  for (const item of items) {
    if (item.status !== "inactive" && item.name) {
      merged.set(
        String(item.name).toLocaleLowerCase("en-US"),
        publicOption(item),
      );
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {Record<string, any>} item */
function publicOption(item) {
  return { type: item.optionType, name: String(item.name || "") };
}

/** @param {string} value */
function normalizeKey(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}
