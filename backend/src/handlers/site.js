import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { jsonResponse, readJsonBody } from "../http.js";
import { deriveSiteId } from "../lib/principal.js";
import { siteMetaKey } from "./keys.js";

const MAX_PLACES = 40;
const MAX_PLACE_NAME_LENGTH = 120;

/**
 * @param {unknown} places
 * @returns {{ ok: true, places: { id: string, name: string, order: number }[] } | { ok: false, error: string }}
 */
export function normalizePlaces(places) {
  if (!Array.isArray(places) || places.length === 0) {
    return { ok: false, error: "places_required" };
  }
  if (places.length > MAX_PLACES) {
    return { ok: false, error: "too_many_places" };
  }

  const seen = new Set();
  const normalized = [];
  for (const raw of places) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "invalid_place" };
    }
    const item = /** @type {{ id?: unknown, name?: unknown }} */ (raw);
    const id = String(item.id || randomUUID()).trim();
    const name = String(item.name || "").trim();
    if (!id) return { ok: false, error: "invalid_place_id" };
    if (seen.has(id)) return { ok: false, error: "duplicate_place_id" };
    if (!name) return { ok: false, error: "blank_place_name" };
    if (name.length > MAX_PLACE_NAME_LENGTH) {
      return { ok: false, error: "place_name_too_long" };
    }
    seen.add(id);
    normalized.push({ id, name, order: normalized.length });
  }

  return { ok: true, places: normalized };
}

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const getSite = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);
  const result = await ddb.send(
    new GetCommand({
      TableName: dynamoTable,
      Key: siteMetaKey(siteId),
    }),
  );

  const site = result.Item || {
    ...siteMetaKey(siteId),
    type: "site",
    siteId,
    name: "Your site",
    places: [],
  };
  return jsonResponse(200, { site });
};

/**
 * @type {import("aws-lambda").APIGatewayProxyHandlerV2WithJWTAuthorizer}
 */
export const putSitePlaces = async (event) => {
  const { dynamoTable } = getConfig();
  const siteId = deriveSiteId(event);

  let body;
  try {
    body = readJsonBody(event);
  } catch {
    return jsonResponse(400, { error: "invalid_json" });
  }

  const parsed = normalizePlaces(
    body && typeof body === "object"
      ? /** @type {{ places?: unknown }} */ (body).places
      : undefined,
  );
  if (!parsed.ok) {
    return jsonResponse(400, { error: parsed.error });
  }

  const now = new Date().toISOString();
  const key = siteMetaKey(siteId);
  const result = await ddb.send(
    new UpdateCommand({
      TableName: dynamoTable,
      Key: key,
      UpdateExpression:
        "SET #type = if_not_exists(#type, :type), siteId = if_not_exists(siteId, :siteId), #name = if_not_exists(#name, :fallbackName), places = :places, placesConfiguredAt = if_not_exists(placesConfiguredAt, :now), updatedAt = :now",
      ExpressionAttributeNames: {
        "#type": "type",
        "#name": "name",
      },
      ExpressionAttributeValues: {
        ":type": "site",
        ":siteId": siteId,
        ":fallbackName": "Your site",
        ":places": parsed.places,
        ":now": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  return jsonResponse(200, { site: result.Attributes });
};
