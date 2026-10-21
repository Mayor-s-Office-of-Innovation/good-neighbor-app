export function migrationTarget(args, env) {
  const option = (name) =>
    args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
  const remote = args.includes("--remote");
  const apply = args.includes("--apply");
  const table = remote ? option("--table") : env.DYNAMO_TABLE;
  const region = remote ? option("--region") : env.AWS_REGION;
  if (!table) throw new Error("A target table is required");
  if (remote) {
    if (!region || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
      throw new Error("Remote mode requires an explicit --region");
    if (apply && option("--confirm-table") !== table)
      throw new Error("Remote writes require --confirm-table matching --table");
  } else {
    const endpoint = new URL(
      env.AWS_ENDPOINT_URL_DYNAMODB || "https://invalid",
    );
    if (
      endpoint.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      !table.startsWith("gnp-local-")
    )
      throw new Error(
        "Local mode requires a localhost endpoint and gnp-local-* table",
      );
  }
  return { remote, apply, table, region };
}

export function monitoringUpdates(item, TableName) {
  if (!String(item.pk).startsWith("SITE#")) return [];
  const Key = { pk: item.pk, sk: item.sk };
  if (item.sk === "#META" && item.compliance?.currentTier !== undefined) {
    const { currentTier, ...compliance } = item.compliance;
    compliance.underEnhancedMonitoring =
      compliance.perimeterChecksRequired !== false &&
      (typeof compliance.underEnhancedMonitoring === "boolean"
        ? compliance.underEnhancedMonitoring
        : Boolean(currentTier));
    return [
      {
        TableName,
        Key,
        UpdateExpression: "SET compliance = :new",
        ConditionExpression: "compliance = :old",
        ExpressionAttributeValues: {
          ":new": compliance,
          ":old": item.compliance,
        },
      },
    ];
  }
  if (
    String(item.sk).startsWith("COMPLIANCE_TERMS#") &&
    item.correctiveActionTier !== undefined
  ) {
    const existing = item.underEnhancedMonitoring;
    return [
      {
        TableName,
        Key,
        UpdateExpression:
          "SET underEnhancedMonitoring = :flag REMOVE correctiveActionTier",
        ConditionExpression:
          "correctiveActionTier = :old AND " +
          (existing === undefined
            ? "attribute_not_exists(underEnhancedMonitoring)"
            : "underEnhancedMonitoring = :observed"),
        ExpressionAttributeValues: {
          ":flag":
            typeof existing === "boolean"
              ? existing
              : Boolean(item.correctiveActionTier),
          ":old": item.correctiveActionTier,
          ...(existing === undefined ? {} : { ":observed": existing }),
        },
      },
    ];
  }
  return [];
}
