import assert from "node:assert/strict";
import { test } from "node:test";
import { testAlarmDelivery } from "./test-alarm-delivery.mjs";

const account = "1".repeat(12);
function fixture({
  wrongAccount = false,
  pendingEast = false,
  wrongAlarm = false,
  state = "OK",
} = {}) {
  const writes = [];
  const aws = (args) => {
    if (args[0] === "sts")
      return { Account: wrongAccount ? "0".repeat(12) : account };
    const region = args[args.indexOf("--region") + 1];
    const suffix = region === "us-east-1" ? "-us-east-1" : "";
    const topic = `arn:aws:sns:${region}:${account}:good-neighbor-app-prod-alarms${suffix}`;
    if (args[0] === "sns")
      return {
        Subscriptions: ["aaron.hans@sf.gov", "beaudry.kock@sfgov.org"].map(
          (email) => ({
            Protocol: "email",
            Endpoint: email,
            TopicArn: topic,
            SubscriptionArn:
              pendingEast && suffix && email.startsWith("beaudry")
                ? "PendingConfirmation"
                : `${topic}:confirmed`,
          }),
        ),
      };
    if (args[1] === "put-metric-data") {
      writes.push(args);
      return {};
    }
    const name = `good-neighbor-app-prod-TEST-alarm-delivery${suffix}`;
    return {
      MetricAlarms: [
        {
          AlarmName: name,
          AlarmArn: `arn:aws:cloudwatch:${region}:${account}:alarm:${name}`,
          ActionsEnabled: true,
          Namespace: "good-neighbor-app-prod-operations",
          MetricName: wrongAlarm ? "RealServiceMetric" : "AlarmDeliveryTest",
          Statistic: "Maximum",
          Period: 60,
          EvaluationPeriods: 1,
          Threshold: 0,
          ComparisonOperator: "GreaterThanThreshold",
          TreatMissingData: "notBreaching",
          AlarmActions: [topic],
          OKActions: [topic],
          StateValue: state,
        },
      ],
    };
  };
  return { aws, writes };
}

test("inspection never sends, including when confirmations are missing", () => {
  const { aws, writes } = fixture({ pendingEast: true });
  const result = testAlarmDelivery(["--account-id", account], aws);
  assert.deepEqual(result.regions[1].missingConfirmedResponders, [
    "beaudry.kock@sfgov.org",
  ]);
  assert.equal(result.receiptVerified, false);
  assert.equal(writes.length, 0);
});

for (const options of [
  { wrongAccount: true },
  { pendingEast: true },
  { wrongAlarm: true },
  { state: "ALARM" },
]) {
  test(`refuses the entire drill before any publish: ${JSON.stringify(options)}`, () => {
    const { aws, writes } = fixture(options);
    assert.throws(() =>
      testAlarmDelivery(["--account-id", account, "--send"], aws),
    );
    assert.equal(writes.length, 0);
  });
}

test("sends only isolated test metrics in both regions, then permits reset", () => {
  for (const [flag, value] of [
    ["--send", 1],
    ["--reset", 0],
  ]) {
    const { aws, writes } = fixture();
    const result = testAlarmDelivery(["--account-id", account, flag], aws);
    assert.equal(result.receiptVerified, false);
    assert.deepEqual(
      writes.map((args) => args[args.indexOf("--region") + 1]),
      ["us-west-2", "us-east-1"],
    );
    for (const args of writes) {
      assert.equal(
        args[args.indexOf("--namespace") + 1],
        "good-neighbor-app-prod-operations",
      );
      assert.deepEqual(JSON.parse(args[args.indexOf("--metric-data") + 1]), [
        { MetricName: "AlarmDeliveryTest", Value: value, Unit: "Count" },
      ]);
    }
  }
});

test("rejects conflicting mutation flags and unknown options before AWS access", () => {
  for (const extra of [["--send", "--reset"], ["--unknown"]]) {
    assert.throws(
      () =>
        testAlarmDelivery(["--account-id", account, ...extra], () =>
          assert.fail("unexpected AWS call"),
        ),
      /Usage/,
    );
  }
});
