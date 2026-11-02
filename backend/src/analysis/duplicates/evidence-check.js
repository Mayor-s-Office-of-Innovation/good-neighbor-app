// Matching reads these fields without a single global revision. Guard both
// present and absent values: adding an invalidation or changing a guidance
// pointer must invalidate the same proof as replacing an existing result.
const fields = [
  "status",
  "analysisId",
  "generatedAt",
  "analyzedAt",
  "concerns",
  "revision",
  "updatedAt",
  "duplicateOf",
  "evaluatedAt",
  "invalidatedAt",
  "resolvedAt",
  "supersededAt",
  "recoveryRequestedAt",
  "conditionResults",
  "possibleDuplicate",
  "matchStrength",
  "targetProjectionKey",
  "assessmentId",
  "supersededByAssessmentId",
  "rawAssessment",
  "taskIds",
  "checkId",
  "conditionId",
  "sourceArtifactIds",
  "taskId",
  "deletedAt",
  "dismissedAt",
  "processingState",
  "originalTaskId",
  "sourceRevision",
  "duplicateGroupVersion",
];

/** Conditions for a single strongly read matching record. Integration results
 * are deliberately excluded: callers update only their own task fields.
 * @param {Record<string, any> | undefined} item
 * @returns {{ConditionExpression:string,ExpressionAttributeNames?:Record<string,string>,ExpressionAttributeValues?:Record<string,any>}}
 */
export function evidenceCondition(item) {
  if (!item) return { ConditionExpression: "attribute_not_exists(sk)" };
  const conditions = ["attribute_exists(sk)"];
  /** @type {Record<string, string>} */
  const names = {};
  /** @type {Record<string, any>} */
  const values = {};
  fields.forEach((field, index) => {
    const name = `#proof${index}`;
    names[name] = field;
    if (item[field] !== undefined) {
      const value = `:proof${index}`;
      values[value] = item[field];
      conditions.push(`${name} = ${value}`);
    } else conditions.push(`attribute_not_exists(${name})`);
  });
  return {
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length
      ? { ExpressionAttributeValues: values }
      : {}),
  };
}
