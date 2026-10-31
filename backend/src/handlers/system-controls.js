import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getConfig } from "../config.js";
import { supervisorOnly, adminPrincipal } from "../lib/admin-auth.js";
import { jsonResponse } from "../http.js";
import { readSilent311Control, silent311Key } from "../domain/silent-311.js";

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const getSystemControls = (event) =>
  supervisorOnly(event, async () =>
    jsonResponse(200, { silent311: await readSilent311Control() }),
  );

/** @type {import("aws-lambda").APIGatewayProxyHandlerV2} */
export const putSystemControls = (event) =>
  supervisorOnly(event, async (body) => {
    if (
      typeof body.enabled !== "boolean" ||
      typeof body.revision !== "number" ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0
    )
      return jsonResponse(400, { error: "invalid_control" });
    const current = await readSilent311Control();
    if (current.revision !== body.revision)
      return jsonResponse(409, { error: "control_changed" });
    if (current.enabled === body.enabled)
      return jsonResponse(200, { silent311: current });
    const now = new Date().toISOString();
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: getConfig().dynamoTable,
          Key: silent311Key,
          UpdateExpression:
            "SET #enabled = :enabled, #revision = :next, epochStartedAt = :now, updatedBy = :actor",
          ConditionExpression:
            "#revision = :prior OR (attribute_not_exists(#revision) AND :prior = :zero)",
          ExpressionAttributeNames: {
            "#enabled": "enabled",
            "#revision": "revision",
          },
          ExpressionAttributeValues: {
            ":enabled": body.enabled,
            ":next": current.revision + 1,
            ":now": now,
            ":prior": current.revision,
            ":zero": 0,
            ":actor": adminPrincipal(event).subject,
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return jsonResponse(409, { error: "control_changed" });
      throw error;
    }
    return jsonResponse(200, {
      silent311: {
        enabled: body.enabled,
        revision: current.revision + 1,
        epochStartedAt: now,
      },
    });
  });
