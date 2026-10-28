import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
const { checkCodeAttemptLimit } = await import("./code-attempt-limit.js");
beforeEach(() => {
  send.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("DYNAMO_TABLE", "test");
});

afterEach(() => vi.restoreAllMocks());

it("atomically caps simultaneous attempts and resumes in the next window", async () => {
  counterStore();
  const now = Date.UTC(2026, 9, 22);
  const outcomes = await Promise.all(
    Array.from({ length: 1001 }, () => checkCodeAttemptLimit(now)),
  );
  expect(outcomes.filter((result) => result === null)).toHaveLength(1000);
  expect(outcomes[1000]).toMatchObject({
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
    ).toEqual([1000, 10000]);
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

/**
 * @param {Map<string, number>} [counts]
 * @returns {Map<string, number>} Atomic test counters.
 */
function counterStore(counts = new Map()) {
  send.mockImplementation(
    /**
     * @param {{input:{TransactItems:Array<{Update:{Key:{sk:string},ExpressionAttributeValues:Record<string,number>}}>}}} command
     * @returns {Promise<object>} Simulated transaction result.
     */ async (command) => {
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
  return counts;
}

it("admits the final daily attempt atomically and resumes only after UTC midnight", async () => {
  const now = Date.UTC(2026, 9, 22, 23, 59, 59);
  const start = Math.floor(now / 1000 / 86400) * 86400;
  const counts = counterStore(new Map([[`86400#${start}`, 9999]]));
  const results = await Promise.all([
    checkCodeAttemptLimit(now),
    checkCodeAttemptLimit(now),
  ]);
  expect(results.filter((result) => result === null)).toHaveLength(1);
  expect(results.find((result) => result !== null)).toMatchObject({
    statusCode: 429,
    headers: { "retry-after": "1" },
  });
  expect(counts.get(`86400#${start}`)).toBe(10000);
  expect(await checkCodeAttemptLimit(now + 1000)).toBeNull();
});

it("retains fixed-window boundary behavior", async () => {
  counterStore();
  const before = Date.UTC(2026, 9, 22, 12, 4, 59);
  for (const now of [before, before + 1000]) {
    const results = await Promise.all(
      Array.from({ length: 1001 }, () => checkCodeAttemptLimit(now)),
    );
    expect(results.filter((result) => result === null)).toHaveLength(1000);
  }
});

it("logs only fixed source and budget outcomes, never submitted codes", async () => {
  send.mockResolvedValueOnce({});
  await checkCodeAttemptLimit(Date.UTC(2026, 9, 22), "register");
  expect(console.info).toHaveBeenCalledWith(
    JSON.stringify({
      marker: "ShortCodeAttempt",
      source: "register",
      outcome: "admitted",
    }),
  );
});
