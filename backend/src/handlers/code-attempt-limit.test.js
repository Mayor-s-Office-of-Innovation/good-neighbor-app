import { beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { checkCodeAttemptLimit } = await import("./code-attempt-limit.js");
beforeEach(() => {
  send.mockReset();
  vi.stubEnv("DYNAMO_TABLE", "test");
});

it("atomically caps simultaneous attempts and resumes in the next window", async () => {
  const counts = new Map();
  send.mockImplementation(
    /** @param {{input:{TransactItems:Array<{Update:{Key:{sk:string},ExpressionAttributeValues:Record<string,number>}}>}}} command */ async (
      command,
    ) => {
      const updates = command.input.TransactItems.map((item) => item.Update);
      const reasons = updates.map((update) => ({
        Code:
          (counts.get(update.Key.sk) || 0) >=
          update.ExpressionAttributeValues[":limit"]
            ? "ConditionalCheckFailed"
            : "None",
      }));
      if (reasons.some((reason) => reason.Code !== "None"))
        throw Object.assign(new Error(), {
          name: "TransactionCanceledException",
          CancellationReasons: reasons,
        });
      for (const update of updates)
        counts.set(update.Key.sk, (counts.get(update.Key.sk) || 0) + 1);
      return {};
    },
  );
  const now = Date.UTC(2026, 9, 22);
  const outcomes = await Promise.all(
    Array.from({ length: 301 }, () => checkCodeAttemptLimit(now)),
  );
  expect(outcomes.filter((result) => result === null)).toHaveLength(300);
  expect(outcomes[300]).toMatchObject({
    statusCode: 429,
    headers: { "retry-after": "300" },
  });
  expect(await checkCodeAttemptLimit(now + 300000)).toBeNull();
  for (const command of send.mock.calls.map((call) => call[0])) {
    expect(command.input.TransactItems).toHaveLength(2);
    expect(
      command.input.TransactItems.map(
        (
          /** @type {{Update:{ExpressionAttributeValues:Record<string,number>}}} */ item,
        ) => item.Update.ExpressionAttributeValues[":limit"],
      ),
    ).toEqual([300, 3000]);
    expect(
      command.input.TransactItems.every(
        (/** @type {{Update:{Key:{pk:string}}}} */ item) =>
          item.Update.Key.pk === "SHORT_CODE_ATTEMPTS",
      ),
    ).toBe(true);
  }
});
it("caps distributed guessing over a day even when the short window changes", async () => {
  send.mockRejectedValue(
    Object.assign(new Error(), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "None" },
        { Code: "ConditionalCheckFailed" },
      ],
    }),
  );
  expect(await checkCodeAttemptLimit(Date.UTC(2026, 9, 22, 1))).toMatchObject({
    statusCode: 429,
    headers: { "retry-after": "82800" },
  });
});
it("fails closed on storage errors and transaction conflicts", async () => {
  for (const error of [
    new Error("offline"),
    Object.assign(new Error(), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "TransactionConflict" }],
    }),
  ]) {
    send.mockRejectedValue(error);
    await expect(checkCodeAttemptLimit()).rejects.toBe(error);
  }
});
