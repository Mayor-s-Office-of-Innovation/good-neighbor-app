import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const responders = ["aaron.hans@sf.gov", "beaudry.kock@sfgov.org"];
const prefix = "good-neighbor-app-prod";

function awsJson(args) {
  const text = execFileSync("aws", [...args, "--output", "json"], {
    encoding: "utf8",
    env: { ...process.env, AWS_PAGER: "" },
  });
  return text.trim() ? JSON.parse(text) : {};
}

/** Read-only by default; finish every preflight before publishing test metrics. */
export function testAlarmDelivery(argv, aws = awsJson) {
  const accountIndex = argv.indexOf("--account-id");
  const account = argv[accountIndex + 1];
  const mode = argv.includes("--send")
    ? "send"
    : argv.includes("--reset")
      ? "reset"
      : "inspect";
  const allowed = new Set(["--account-id", account, "--send", "--reset"]);
  if (
    accountIndex < 0 ||
    !/^\d{12}$/.test(account || "") ||
    argv.some((arg) => !allowed.has(arg)) ||
    argv.filter((arg) => arg === "--account-id").length !== 1 ||
    (argv.includes("--send") && argv.includes("--reset"))
  ) {
    throw new Error(
      "Usage: node scripts/test-alarm-delivery.mjs --account-id <prod-account-id> [--send | --reset]",
    );
  }
  if (aws(["sts", "get-caller-identity"]).Account !== account) {
    throw new Error("AWS account mismatch; no metrics sent");
  }
  const regions = ["us-west-2", "us-east-1"].map((region) => {
    const suffix = region === "us-east-1" ? "-us-east-1" : "";
    const topic = `arn:aws:sns:${region}:${account}:${prefix}-alarms${suffix}`;
    const alarmName = `${prefix}-TEST-alarm-delivery${suffix}`;
    const subscriptions = [];
    let nextToken;
    do {
      const page = aws([
        "sns",
        "list-subscriptions-by-topic",
        "--region",
        region,
        "--topic-arn",
        topic,
        ...(nextToken ? ["--next-token", nextToken] : []),
        "--no-paginate",
      ]);
      subscriptions.push(...(page.Subscriptions || []));
      nextToken = page.NextToken;
    } while (nextToken);
    const missing = responders.filter(
      (email) =>
        !subscriptions.some(
          (s) =>
            s.Protocol === "email" &&
            s.Endpoint === email &&
            s.TopicArn === topic &&
            s.SubscriptionArn?.startsWith(`${topic}:`),
        ),
    );
    const { MetricAlarms = [] } = aws([
      "cloudwatch",
      "describe-alarms",
      "--region",
      region,
      "--alarm-names",
      alarmName,
    ]);
    const alarm = MetricAlarms[0];
    const configured =
      alarm?.AlarmName === alarmName &&
      alarm.AlarmArn ===
        `arn:aws:cloudwatch:${region}:${account}:alarm:${alarmName}` &&
      alarm.ActionsEnabled === true &&
      alarm.Namespace === `${prefix}-operations` &&
      alarm.MetricName === "AlarmDeliveryTest" &&
      !alarm.Metrics?.length &&
      !alarm.Dimensions?.length &&
      alarm.Statistic === "Maximum" &&
      alarm.Period === 60 &&
      alarm.EvaluationPeriods === 1 &&
      alarm.Threshold === 0 &&
      alarm.ComparisonOperator === "GreaterThanThreshold" &&
      alarm.TreatMissingData === "notBreaching" &&
      alarm.AlarmActions?.length === 1 &&
      alarm.AlarmActions[0] === topic &&
      alarm.OKActions?.length === 1 &&
      alarm.OKActions[0] === topic;
    return {
      region,
      topic,
      alarmName,
      missingConfirmedResponders: missing,
      configured,
      state: alarm?.StateValue || "NOT_DEPLOYED",
    };
  });
  if (mode !== "inspect") {
    if (
      regions.some((r) => !r.configured || r.missingConfirmedResponders.length)
    ) {
      throw new Error(
        `Preflight failed; no metrics sent: ${JSON.stringify(regions)}`,
      );
    }
    if (mode === "send" && regions.some((r) => r.state !== "OK")) {
      throw new Error(
        "Both test alarms must be OK before a new drill; no metrics sent",
      );
    }
    for (const { region } of regions) {
      aws([
        "cloudwatch",
        "put-metric-data",
        "--region",
        region,
        "--namespace",
        `${prefix}-operations`,
        "--metric-data",
        JSON.stringify([
          {
            MetricName: "AlarmDeliveryTest",
            Value: mode === "send" ? 1 : 0,
            Unit: "Count",
          },
        ]),
      ]);
    }
  }
  return {
    mode,
    drillId: randomUUID(),
    observedAt: new Date().toISOString(),
    regions,
    receiptVerified: false,
    nextStep:
      "Record human acknowledgment from both responders in both regions; metric publication is not delivery proof.",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      JSON.stringify(testAlarmDelivery(process.argv.slice(2)), null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
