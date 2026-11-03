import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb } from "../db.js";
import { analysisKey, assessmentKey, conditionKey, taskKey } from "./keys.js";

/** @param {unknown} value */
export function validDescription(value) {
  return (
    typeof value === "string" &&
    value.trim().length >= 5 &&
    value.trim().length <= 4000
  );
}

/** Preserve the original filing instructions when a card is edited. Workers must
 * not turn an outstanding initial filing into a filing for the edited action.
 * @param {Record<string, any>} task
 */
export function silent311Snapshot(task) {
  return (
    task.silent311Snapshot ??
    Object.fromEntries(
      [
        "appActions",
        "category",
        "analyzerCategory",
        "description",
        "kind",
        "ruleId",
        "category311",
        "phoneNumber",
        "guidance",
        "label",
      ]
        .filter((key) => task[key] !== undefined)
        .map((key) => [key, task[key]]),
    )
  );
}

/** @param {Record<string, any>} item @param {string} description */
export function descriptionPatch(item, description) {
  return {
    description: description.trim(),
    descriptionEdited: true,
    ...(item.taskId ? { silent311Snapshot: silent311Snapshot(item) } : {}),
  };
}

/** Prepare atomic text corrections; never call the analyzer or evaluate guidance.
 * The caller may merge the clicked task's patch into its action write.
 * @param {{table: string, siteId: string, checkId?: string, artifactId?: string,
 * conditionId?: string, assessmentId?: string, revision?: number, requestId?: string, task?: Record<string, any>, description: string, title?: string}} opts
 */
export async function descriptionWrites(opts) {
  const { table, siteId, description } = opts;
  const read = async (/** @type {{pk:string, sk:string}} */ Key) =>
    (
      await ddb.send(
        new GetCommand({ TableName: table, Key, ConsistentRead: true }),
      )
    ).Item;
  const task = opts.task;
  if (task && task.status !== "open")
    throw Object.assign(new Error("Work has begun"), { status: 409 });
  const checkId = String(task?.checkId || opts.checkId || "");
  const artifactId = String(
    task?.sourceArtifactIds?.[0] ||
      task?.source?.artifactIds?.[0] ||
      opts.artifactId ||
      "",
  );
  const conditionId = String(task?.conditionId || opts.conditionId || "");
  const pointerKey = {
    pk: `SITE#${siteId}`,
    sk: `GUIDANCE_CURRENT#${JSON.stringify([checkId, artifactId])}`,
  };
  const pointer =
    !task?.assessmentId && !opts.assessmentId && artifactId
      ? await read(pointerKey)
      : null;
  const assessmentId =
    task?.assessmentId || opts.assessmentId || pointer?.assessmentId;
  /** @type {NonNullable<import('@aws-sdk/lib-dynamodb').TransactWriteCommandInput['TransactItems']>} */
  const writes = [];
  /** @type {Record<string, any>[]} */
  const tasks = task ? [task] : [];
  let condition;
  if (assessmentId && conditionId && conditionId !== "__summary__") {
    const assessment = await read(assessmentKey(siteId, assessmentId));
    condition = await read(conditionKey(siteId, assessmentId, conditionId));
    if (
      !assessment ||
      (opts.assessmentId &&
        (assessment.checkId !== checkId ||
          !condition?.source?.artifactIds?.includes(artifactId))) ||
      assessment.supersededByAssessmentId ||
      !condition ||
      (task
        ? condition.status === "rejected"
        : !["needs_answer", "manual_review"].includes(condition.status))
    )
      throw Object.assign(new Error("Description changed while editing"), {
        status: 409,
      });
    if (
      opts.revision !== undefined &&
      opts.revision !== Number(assessment.assessmentRevision || 0)
    )
      throw Object.assign(new Error("Description changed while editing"), {
        status: 409,
      });
    // Answering a question and editing its text share the assessment revision.
    // This prevents a concurrent answer from minting a task with the old text.
    writes.push({
      Update: {
        TableName: table,
        Key: assessmentKey(siteId, assessmentId),
        UpdateExpression: "SET assessmentRevision = :next",
        ConditionExpression:
          "attribute_not_exists(supersededByAssessmentId) AND (attribute_not_exists(assessmentRevision) OR assessmentRevision = :prior)",
        ExpressionAttributeValues: {
          ":prior": Number(assessment.assessmentRevision || 0),
          ":next": Number(assessment.assessmentRevision || 0) + 1,
        },
      },
    });
    writes.push({
      Update: {
        TableName: table,
        Key: conditionKey(siteId, assessmentId, conditionId),
        UpdateExpression:
          "SET description = :text, descriptionEdited = :yes" +
          (opts.requestId ? ", detailsEditId = :requestId" : "") +
          (opts.title !== undefined
            ? ", userFriendlyLabel = :title, titleEdited = :yes"
            : ""),
        ConditionExpression:
          "attribute_exists(sk) AND #status = :conditionStatus",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":conditionStatus": condition.status,
          ":text": description.trim(),
          ":yes": true,
          ...(opts.requestId ? { ":requestId": opts.requestId } : {}),
          ...(opts.title !== undefined ? { ":title": opts.title.trim() } : {}),
        },
      },
    });
    if (!task)
      for (const id of condition.taskIds || []) {
        const member = await read(taskKey(siteId, id));
        if (member) {
          if (member.status !== "open")
            throw Object.assign(new Error("Work has begun"), { status: 409 });
          tasks.push(member);
        }
      }
  } else if (!task) {
    if (
      !checkId ||
      !artifactId ||
      (conditionId && conditionId !== "__summary__")
    )
      throw Object.assign(new Error("Description not found"), { status: 404 });
    const analysis = await read(analysisKey(siteId, checkId, artifactId));
    if (!analysis || analysis.concerns?.length)
      throw Object.assign(new Error("Description not found"), { status: 404 });
    writes.push({
      Update: {
        TableName: table,
        Key: analysisKey(siteId, checkId, artifactId),
        UpdateExpression:
          "SET gradeDescription = :text, descriptionEdited = :yes",
        ConditionExpression: "attribute_exists(sk)",
        ExpressionAttributeValues: {
          ":text": description.trim(),
          ":yes": true,
        },
      },
    });
  }
  return {
    writes,
    tasks,
    condition: condition
      ? {
          ...condition,
          ...descriptionPatch(condition, description),
          ...(opts.requestId ? { detailsEditId: opts.requestId } : {}),
          ...(opts.title !== undefined
            ? { userFriendlyLabel: opts.title.trim(), titleEdited: true }
            : {}),
        }
      : null,
  };
}

/** A field-only update cannot overwrite worker results or other task changes.
 * @param {string} table @param {Record<string, any>} task @param {string} description @param {string} [title]
 */
export function taskDescriptionWrite(table, task, description, title) {
  return {
    Update: {
      TableName: table,
      Key: { pk: task.pk, sk: task.sk },
      UpdateExpression:
        "SET description = :text, descriptionEdited = :yes, updatedAt = :now, silent311Snapshot = if_not_exists(silent311Snapshot, :snapshot)" +
        (title !== undefined
          ? ", userFriendlyLabel = :title, titleEdited = :yes"
          : ""),
      ConditionExpression:
        "attribute_exists(sk) AND #status = :status AND " +
        (task.updatedAt
          ? "updatedAt = :updated"
          : "attribute_not_exists(updatedAt)"),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":text": description.trim(),
        ":yes": true,
        ":snapshot": silent311Snapshot(task),
        ":status": "open",
        ...(title !== undefined ? { ":title": title.trim() } : {}),
        ":now": new Date().toISOString(),
        ...(task.updatedAt ? { ":updated": task.updatedAt } : {}),
      },
    },
  };
}

/** @param {unknown} title */
export function validTitle(title) {
  return (
    typeof title === "string" &&
    title.trim().length > 0 &&
    title.trim().length <= 160
  );
}
