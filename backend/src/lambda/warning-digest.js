import {
  CloudWatchClient,
  GetMetricDataCommand,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

const cloudwatch = new CloudWatchClient({});
const sns = new SNSClient({});

/**
 * Summarize aggregate warnings only; never read logs, reports, or queue bodies.
 * The scheduled event time anchors retries to the same completed UTC day.
 * @param {{time: string}} event
 * @param {{cw?: Pick<CloudWatchClient, 'send'>, notifications?: Pick<SNSClient, 'send'>, env?: NodeJS.ProcessEnv}} [deps]
 * @returns {Promise<{sent: boolean}>}
 */
export async function handler(event, deps = {}) {
  const env = deps.env ?? process.env;
  const prefix = env.ALARM_PREFIX;
  const topic = env.DIGEST_TOPIC_ARN;
  if (!prefix || !topic)
    throw new Error("Missing warning digest configuration");
  const end = new Date(event.time);
  if (!Number.isFinite(end.getTime()))
    throw new Error("Invalid scheduled time");
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 86_400_000);
  const metrics = [
    ["errors", "ClientErrorForwardFailed"],
    ["errors", "ClientEventForwardFailed"],
    ["duplicates", "DuplicateFailedCandidates"],
    ["duplicates", "DuplicateWorkerFailures"],
  ];
  const cw = deps.cw ?? cloudwatch;
  const data = await cw.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: metrics.map(([namespace, name], index) => ({
        Id: `m${index}`,
        MetricStat: {
          Metric: { Namespace: `${prefix}-${namespace}`, MetricName: name },
          Period: 3600,
          Stat: "Sum",
        },
        ReturnData: true,
      })),
    }),
  );
  // Never send a partial report that looks like a clean day.
  if (
    data.NextToken ||
    data.Messages?.length ||
    metrics.some(
      (_, index) =>
        data.MetricDataResults?.find((r) => r.Id === `m${index}`)
          ?.StatusCode !== "Complete",
    )
  )
    throw new Error("Incomplete warning metrics");
  const totals = metrics
    .map(([, name], index) => ({
      name,
      count: (
        data.MetricDataResults?.find((r) => r.Id === `m${index}`)?.Values ?? []
      ).reduce((sum, value) => sum + value, 0),
    }))
    .filter((m) => m.count > 0);
  const names = ["duplicate-dead-letters", "duplicate-queue-backlog"].map(
    (suffix) => `${prefix}-${suffix}`,
  );
  const alarms = await cw.send(
    new DescribeAlarmsCommand({ AlarmNames: names }),
  );
  if (
    names.some(
      (name) => !alarms.MetricAlarms?.some((a) => a.AlarmName === name),
    )
  )
    throw new Error("Missing duplicate alarm coverage");
  const active = (alarms.MetricAlarms ?? []).filter(
    (a) => a.StateValue !== "OK",
  );
  if (!totals.length && !active.length) return { sent: false };
  const region = env.AWS_REGION ?? "us-west-2";
  await (deps.notifications ?? sns).send(
    new PublishCommand({
      TopicArn: topic,
      Subject: `${prefix}: daily warning digest`,
      Message: [
        `Warning digest: ${start.toISOString()} through ${end.toISOString()} (exclusive).`,
        ...totals.map((m) => `${m.name}: ${m.count} recorded failure attempts`),
        ...active.map((a) => `${a.AlarmName}: ${a.StateValue} at digest time`),
        "Counts include retries, not unique incidents. Missing metrics mean no observations, not verified health.",
        "A quiet period does not establish recovery of failed work. Persistent queue alarms need an owner until resolved.",
        `Diagnostics: https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:`,
        "No report content or personal information is included. Delivery may repeat on scheduler/SNS retries.",
      ].join("\n"),
    }),
  );
  return { sent: true };
}
