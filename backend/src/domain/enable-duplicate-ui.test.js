import { expect, it, vi } from "vitest";
import {
  enableDuplicateUi,
  DUPLICATE_UI_ROLLOUT_KEY,
} from "./enable-duplicate-ui.js";

it("dry runs every page without writing", async () => {
  const cursor = { pk: "SITE#one", sk: "#META" };
  const send = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({
      Items: [{ pk: "SITE#one", sk: "#META" }],
      LastEvaluatedKey: cursor,
    })
    .mockResolvedValueOnce({ Items: [{ pk: "SITE#two", sk: "#META" }] });
  expect(await enableDuplicateUi({ send }, "table")).toEqual({
    eligible: 2,
    written: 0,
  });
  expect(send.mock.calls[2][0].input.ExclusiveStartKey).toEqual(cursor);
  expect(
    send.mock.calls
      .slice(1)
      .every(([command]) => command.constructor.name === "ScanCommand"),
  ).toBe(true);
});

it("enables missing and disabled flags, preserving unrelated flags and guarding races", async () => {
  const send = vi.fn().mockResolvedValue({});
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({
    Items: [
      { pk: "SITE#one", sk: "#META" },
      {
        pk: "SITE#two",
        sk: "#META",
        featureFlags: { duplicateDetection: false, other: true },
      },
    ],
  });
  expect(await enableDuplicateUi({ send }, "table", true)).toEqual({
    eligible: 2,
    written: 2,
  });
  expect(send.mock.calls[2][0].input).toMatchObject({
    ConditionExpression: expect.stringContaining(
      "attribute_not_exists(featureFlags)",
    ),
    ExpressionAttributeValues: {
      ":flags": { duplicateDetection: true },
      ":version": 1,
    },
  });
  expect(send.mock.calls[3][0].input).toMatchObject({
    ConditionExpression: expect.stringContaining("featureFlags = :prior"),
    ExpressionAttributeValues: {
      ":flags": { duplicateDetection: true, other: true },
      ":prior": { duplicateDetection: false, other: true },
    },
  });
  expect(send.mock.calls[1][0].input.FilterExpression).toContain(
    "attribute_not_exists(duplicateUiRolloutVersion)",
  );
});

it("fails on a concurrent settings edit so deployment cannot silently skip a site", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ Items: [{ pk: "SITE#one", sk: "#META" }] })
    .mockRejectedValueOnce(
      Object.assign(new Error("changed"), {
        name: "ConditionalCheckFailedException",
      }),
    );
  await expect(
    enableDuplicateUi({ send }, "table", true),
  ).rejects.toMatchObject({ name: "ConditionalCheckFailedException" });
  expect(
    send.mock.calls.some(
      ([command]) => command.constructor.name === "PutCommand",
    ),
  ).toBe(false);
});

it.each([false, true])(
  "never scans or changes future Sites after rollout completion (apply=%s)",
  async (apply) => {
    const send = vi.fn().mockResolvedValueOnce({ Item: { completed: true } });
    expect(await enableDuplicateUi({ send }, "table", apply)).toEqual({
      eligible: 0,
      written: 0,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: DUPLICATE_UI_ROLLOUT_KEY,
      ConsistentRead: true,
    });
  },
);

it("marks the environment complete only after every page has been applied", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({
      Items: [],
      LastEvaluatedKey: { pk: "SITE#already-migrated", sk: "#META" },
    })
    .mockResolvedValueOnce({ Items: [{ pk: "SITE#remaining", sk: "#META" }] })
    .mockResolvedValue({});
  await enableDuplicateUi({ send }, "table", true);
  expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
    "GetCommand",
    "ScanCommand",
    "ScanCommand",
    "UpdateCommand",
    "PutCommand",
  ]);
  expect(send.mock.calls.at(-1)?.[0].input.Item).toEqual({
    ...DUPLICATE_UI_ROLLOUT_KEY,
    completed: true,
  });
});
