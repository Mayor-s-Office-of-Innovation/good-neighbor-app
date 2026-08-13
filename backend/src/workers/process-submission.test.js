import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Document Client so the worker's DynamoDB calls hit a spy instead of
// AWS / DynamoDB Local — pure unit test, sub-second, no JVM. `vi.hoisted` lets
// the factory below reference `send` despite vi.mock being hoisted above imports.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));

const { handler } = await import("./process-submission.js");

/**
 * Build a minimal SQSEvent carrying one JSON message body.
 * @param {{ requestId: string, subject: string, body: string }} message
 * @returns {import("aws-lambda").SQSEvent}
 */
function sqsEvent(message) {
  return /** @type {import("aws-lambda").SQSEvent} */ ({
    Records: [{ body: JSON.stringify(message) }],
  });
}

const message = {
  requestId: "req-123",
  subject: "cognito-sub-1",
  body: JSON.stringify({ hello: "world" }),
};

describe("process-submission worker", () => {
  beforeEach(() => {
    send.mockReset();
    process.env.BEDROCK_MODEL_ID = "model";
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "gnp-test-app";
  });

  it("writes a receipt item conditionally on first delivery", async () => {
    send.mockResolvedValueOnce({});

    await handler(sqsEvent(message), /** @type {any} */ ({}), () => {});

    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd).toBeInstanceOf(PutCommand);
    expect(cmd.input.TableName).toBe("gnp-test-app");
    expect(cmd.input.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(cmd.input.Item).toMatchObject({
      pk: "SUBMISSION#req-123",
      sk: "#RECEIPT",
      requestId: "req-123",
      cognitoSubject: "cognito-sub-1",
      payload: { hello: "world" },
      status: "received",
    });
  });

  it("marks a replay duplicate when the receipt already exists", async () => {
    const conditional = Object.assign(new Error("exists"), {
      name: "ConditionalCheckFailedException",
    });
    send.mockImplementation((cmd) =>
      cmd instanceof PutCommand
        ? Promise.reject(conditional)
        : Promise.resolve({}),
    );

    await handler(sqsEvent(message), /** @type {any} */ ({}), () => {});

    expect(send).toHaveBeenCalledTimes(2);
    const update = send.mock.calls[1][0];
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.Key).toEqual({
      pk: "SUBMISSION#req-123",
      sk: "#RECEIPT",
    });
    expect(update.input.ExpressionAttributeValues[":status"]).toBe(
      "duplicate_replay",
    );
  });

  it("rethrows a non-conditional DynamoDB error", async () => {
    send.mockRejectedValueOnce(new Error("throughput exceeded"));

    await expect(
      handler(sqsEvent(message), /** @type {any} */ ({}), () => {}),
    ).rejects.toThrow("throughput exceeded");
  });
});
