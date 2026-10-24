// Small, replay-safe reporting snapshots. Source records remain authoritative.
import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { getDynamoTableName } from "../config.js";

/** Match the fallback identity used by the capture UI for older analyzer results.
 * @param {string} artifactId
 * @param {Record<string, any>} concern
 * @param {number} index
 */
export function statusConditionId(artifactId, concern, index) {
  return (
    concern.conditionId ||
    `${artifactId}-${String(index + 1).padStart(3, "0")}-${String(
      concern.category || "",
    )
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`
  );
}

/** @param {Record<string, any>} item */
export function statusRecords(item) {
  if (!String(item.pk).startsWith("SITE#")) return [];
  const siteId = item.pk.slice(5),
    sk = String(item.sk);
  const pk = `STATUS#${siteId}`;
  /** @type {Record<string, any>[]} */
  const records = [];
  const add = (
    /** @type {string} */ kind,
    /** @type {string} */ at,
    /** @type {string} */ id,
    /** @type {Record<string, any>} */ data,
  ) => {
    if (!at || !Number.isFinite(Date.parse(at))) return;
    records.push({
      pk,
      sk: `${at}#${kind}#${id}`,
      kind,
      at,
      siteId,
      expiresAt: Math.floor(Date.parse(at) / 1000) + 30 * 86400,
      ...data,
    });
  };
  if (sk === "#META")
    return [
      {
        pk: "STATUS_SITES",
        sk: siteId,
        siteId,
        name: item.name || siteId,
        status: item.status || "",
        version: item.updatedAt || item.createdAt || "",
      },
    ];
  if (/^CHECK#[^#]+#ART#[^#]+$/.test(sk) && item.receivedAt) {
    add("submissions", item.receivedAt, `${item.checkId}:${item.artifactId}`, {
      checkId: item.checkId,
      artifactId: item.artifactId,
    });
  }
  if (/^CHECK#[^#]+$/.test(sk) && item.flowType !== "single-problem") {
    add("checks", item.startedAt, item.checkId, {
      checkId: item.checkId,
      status: item.status,
      version: item.completedAt || item.startedAt,
    });
  }
  if (/^CHECK#[^#]+#ANALYSIS#[^#]+$/.test(sk) && item.status === "analyzed") {
    for (const [index, concern] of (item.concerns || []).entries()) {
      if (!(concern.rating > 0)) continue;
      const identity = `${item.checkId}:${item.artifactId}:${statusConditionId(item.artifactId, concern, index)}`;
      add("issues", item.generatedAt || item.analyzedAt, identity, {
        issueId: identity,
        category: concern.category || "unknown",
      });
    }
  }
  if (sk.startsWith("ISSUE_DELETION#"))
    add("deletions", item.deletedAt, sk, {
      category: item.category || "unknown",
    });
  if (sk.startsWith("CARE_WORK#"))
    add("actions", item.createdAt, item.workId, {
      category: item.kind || "unknown",
    });
  if (
    /^TASK#[^#]+#UPDATE#/.test(sk) &&
    !item.actionSourceTaskId &&
    !["duplicate_detected", "duplicate_linked"].includes(item.type)
  ) {
    add("actions", item.occurredAt, item.updateId, {
      category: item.type || "unknown",
      label: item.label || "",
    });
  }
  if (sk.startsWith("DUP_LINK#")) {
    add("duplicates", item.occurredAt, item.taskId, {
      taskId: item.taskId,
      originalTaskId: item.originalTaskId,
      checkId: item.checkId || "",
      artifactId: item.artifactId || "",
      conditionId: item.conditionId || "",
      matchedObservationId: item.matchedObservationId || "",
    });
  }
  return records;
}

/** @param {Record<string, any>} item */
export async function projectStatus(item) {
  for (const record of statusRecords(item)) {
    const mutable = record.pk === "STATUS_SITES" || record.kind === "checks";
    try {
      if (["issues", "duplicates"].includes(record.kind)) {
        const identity =
          record.kind === "issues" ? record.issueId : record.taskId;
        await ddb.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: getDynamoTableName(),
                  Item: {
                    pk: record.pk,
                    sk: `SEEN#${record.kind}#${identity}`,
                  },
                  ConditionExpression: "attribute_not_exists(sk)",
                },
              },
              { Put: { TableName: getDynamoTableName(), Item: record } },
            ],
          }),
        );
        continue;
      }
      await ddb.send(
        new PutCommand({
          TableName: getDynamoTableName(),
          Item: record,
          ...(!mutable
            ? { ConditionExpression: "attribute_not_exists(sk)" }
            : {
                ConditionExpression:
                  "attribute_not_exists(#version) OR #version <= :version",
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: { ":version": record.version },
              }),
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        continue;
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException" &&
        /** @type {any} */ (error).CancellationReasons?.[0]?.Code ===
          "ConditionalCheckFailed"
      )
        continue;
      throw error;
    }
  }
}

/** @param {number} numerator @param {number} denominator @param {number} green @param {number} orange */
export function health(numerator, denominator, green, orange) {
  if (!denominator) return { state: "gray", percent: null };
  const percent = (numerator / denominator) * 100;
  return {
    state: percent >= green ? "green" : percent >= orange ? "orange" : "red",
    percent,
  };
}
