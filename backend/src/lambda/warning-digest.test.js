import { beforeEach, expect, it, vi } from "vitest";
import { handler } from "./warning-digest.js";

const env = {
  ALARM_PREFIX: "example-dev",
  DIGEST_TOPIC_ARN: `arn:aws:sns:us-west-2:${"1".repeat(12)}:example-dev-alarms`,
  AWS_REGION: "us-west-2",
};
const event = { time: "2026-10-30T16:00:00Z" };
const send = vi.fn();
const publish = vi.fn();
const deps = { cw: { send }, notifications: { send: publish }, env };

/**
 * @param {number[]} [values]
 * @returns {object}
 */
function metrics(values = []) {
  return {
    MetricDataResults: [0, 1, 2, 3].map((i) => ({
      Id: `m${i}`,
      StatusCode: "Complete",
      Values: i === 0 ? values : [],
    })),
  };
}
/**
 * @param {string} [state]
 * @returns {object}
 */
function alarms(state = "OK") {
  return {
    MetricAlarms: ["duplicate-dead-letters", "duplicate-queue-backlog"].map(
      (s) => ({
        AlarmName: `example-dev-${s}`,
        StateValue: state,
      }),
    ),
  };
}
beforeEach(() => vi.resetAllMocks());

it("stays quiet when no failure attempts or active queue alarms are observed", async () => {
  send.mockResolvedValueOnce(metrics()).mockResolvedValueOnce(alarms());
  expect(await handler(event, deps)).toEqual({ sent: false });
  expect(publish).not.toHaveBeenCalled();
});

it("uses a completed UTC day, counts retries, and reminds about unresolved queues", async () => {
  send
    .mockResolvedValueOnce(metrics([2, 3]))
    .mockResolvedValueOnce(alarms("ALARM"));
  expect(await handler(event, deps)).toEqual({ sent: true });
  const query = send.mock.calls[0][0].input;
  expect(query.StartTime.toISOString()).toBe("2026-10-29T00:00:00.000Z");
  expect(query.EndTime.toISOString()).toBe("2026-10-30T00:00:00.000Z");
  const message = publish.mock.calls[0][0].input;
  expect(message.TopicArn).toBe(env.DIGEST_TOPIC_ARN);
  expect(message.Message).toContain(
    "ClientErrorForwardFailed: 5 recorded failure attempts",
  );
  expect(message.Message).toContain("duplicate-dead-letters: ALARM");
  expect(message.Message).toContain("not unique incidents");
});

it("fails rather than interpreting incomplete metric results as a quiet day", async () => {
  send.mockResolvedValueOnce({
    MetricDataResults: [{ Id: "m0", StatusCode: "PartialData" }],
  });
  await expect(handler(event, deps)).rejects.toThrow(
    "Incomplete warning metrics",
  );
  expect(publish).not.toHaveBeenCalled();
});

it("fails if queue alarm coverage disappears", async () => {
  send
    .mockResolvedValueOnce(metrics())
    .mockResolvedValueOnce({ MetricAlarms: [] });
  await expect(handler(event, deps)).rejects.toThrow(
    "Missing duplicate alarm coverage",
  );
});

it("propagates publish failure so Lambda can retry and alert", async () => {
  send.mockResolvedValueOnce(metrics([1])).mockResolvedValueOnce(alarms());
  publish.mockRejectedValueOnce(new Error("delivery unavailable"));
  await expect(handler(event, deps)).rejects.toThrow("delivery unavailable");
});

it("reminds about an unresolved DLQ even when no new failures were recorded", async () => {
  send.mockResolvedValueOnce(metrics()).mockResolvedValueOnce(alarms("ALARM"));
  expect(await handler(event, deps)).toEqual({ sent: true });
  expect(publish.mock.calls[0][0].input.Message).toContain(
    "duplicate-dead-letters: ALARM at digest time",
  );
});

it("does not publish a truncated report when CloudWatch returns another page", async () => {
  send.mockResolvedValueOnce({ ...metrics([1]), NextToken: "synthetic-page" });
  await expect(handler(event, deps)).rejects.toThrow(
    "Incomplete warning metrics",
  );
  expect(publish).not.toHaveBeenCalled();
});

it("keeps a delayed retry on the original scheduled day's reporting window", async () => {
  send.mockResolvedValueOnce(metrics()).mockResolvedValueOnce(alarms());
  await handler({ time: "2026-10-01T16:00:00Z" }, deps);
  const query = send.mock.calls[0][0].input;
  expect(query.StartTime.toISOString()).toBe("2026-09-30T00:00:00.000Z");
  expect(query.EndTime.toISOString()).toBe("2026-10-01T00:00:00.000Z");
});

it("rejects invalid scheduled times before calling AWS", async () => {
  await expect(handler({ time: "invalid" }, deps)).rejects.toThrow(
    "Invalid scheduled time",
  );
  expect(send).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});
