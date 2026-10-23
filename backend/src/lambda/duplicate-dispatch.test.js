import { it, expect, vi } from "vitest";
import { marshall } from "@aws-sdk/util-dynamodb";
const state = vi.hoisted(() => ({ messages: /** @type {string[]} */ ([]) }));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    async send(/** @type {{input:{MessageBody:string}}} */ c) {
      state.messages.push(c.input.MessageBody);
    }
  },
  SendMessageCommand: class {
    constructor(/** @type {object} */ input) {
      this.input = input;
    }
  },
}));
vi.mock("../db.js", () => ({ ddb: { send: vi.fn() } }));
import { handler } from "./duplicate-dispatch.js";
it("queues cache preparation on artifact registration without coupling the normal analyzer", async () => {
  state.messages = [];
  const artifact = {
    pk: "SITE#site",
    sk: "CHECK#check#ART#photo",
    checkId: "check",
    artifactId: "photo",
    s3Key: "checks/site/check/photo",
  };
  const record = {
    dynamodb: { NewImage: marshall(artifact), SequenceNumber: "1" },
  };
  const event = /** @type {import('aws-lambda').DynamoDBStreamEvent} */ (
    /** @type {unknown} */ ({ Records: [record] })
  );
  await handler(
    event,
    /** @type {import('aws-lambda').Context} */ (/** @type {unknown} */ ({})),
    () => {},
  );
  expect(state.messages.map((m) => JSON.parse(m))).toEqual([
    {
      siteId: "site",
      checkId: "check",
      artifactId: "photo",
      prepareOnly: true,
    },
  ]);
  record.dynamodb = { ...record.dynamodb, ...{ OldImage: marshall(artifact) } };
  await handler(
    event,
    /** @type {import('aws-lambda').Context} */ (/** @type {unknown} */ ({})),
    () => {},
  );
  expect(state.messages).toHaveLength(1);
});
