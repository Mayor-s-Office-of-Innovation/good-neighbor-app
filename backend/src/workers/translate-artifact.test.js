import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ddbSend, translate, createAnalyzerClient } = vi.hoisted(() => ({
  ddbSend: vi.fn(),
  translate: vi.fn(),
  createAnalyzerClient: vi.fn(),
}));
vi.mock("../db.js", () => ({ ddb: { send: ddbSend } }));
vi.mock("../analysis/analyzer-client.js", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, createAnalyzerClient };
});

const { AnalyzerError } = await import("../analysis/analyzer-client.js");
const { handler, translateArtifact } = await import("./translate-artifact.js");

const trash = {
  user_friendly_label: "Trash scattered along curb",
  description: "Several wrappers along the curb.",
};
const tent = {
  user_friendly_label: "Tent against wall",
  description: "A tent set up against the wall.",
};
const spanish = { es: { user_friendly_label: "Basura", description: "Env." } };
const everything = {
  es: spanish.es,
  fil: { user_friendly_label: "Basura fil", description: "Fil." },
  vi: { user_friendly_label: "Rác", description: "Vi." },
  "zh-Hant": { user_friendly_label: "垃圾", description: "Zh." },
};

/** @type {import("../analysis/translate-enqueue.js").TranslateMessage} */
const msg = {
  type: "translate_artifact",
  siteId: "site-1",
  checkId: "chk_01",
  artifactId: "art_1",
  items: [trash, tent],
};

/**
 * Stored-state fixture the DynamoDB mock serves: the ANALYSIS# concerns, the
 * CONDITION# rows under `ASSESSMENT#chk_01-art_1…`, and the TASK# rows.
 * @param {object} state
 * @param {Record<string, unknown>[]} [state.concerns]
 * @param {Record<string, unknown>[]} [state.conditions]
 * @param {Record<string, unknown>[]} [state.tasks]
 */
function mockStore({ concerns = [], conditions = [], tasks = [] }) {
  ddbSend.mockImplementation(async (command) => {
    if (command instanceof GetCommand) {
      return { Item: { status: "analyzed", concerns } };
    }
    if (command instanceof QueryCommand) {
      expect(command.input.ExpressionAttributeValues).toEqual({
        ":pk": "SITE#site-1",
        ":prefix": "ASSESSMENT#chk_01-art_1",
      });
      return { Items: conditions };
    }
    if (command instanceof BatchGetCommand) {
      const keys = command.input.RequestItems?.["gnp-test-app"]?.Keys ?? [];
      return {
        Responses: {
          "gnp-test-app": tasks.filter((task) =>
            keys.some((key) => key.sk === task.sk),
          ),
        },
      };
    }
    if (command instanceof UpdateCommand) return {};
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
}

/** @returns {UpdateCommand[]} */
const updates = () =>
  ddbSend.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof UpdateCommand);

beforeEach(() => {
  ddbSend.mockReset();
  translate.mockReset();
  createAnalyzerClient.mockReset().mockReturnValue({ translate });
  process.env.S3_UPLOAD_BUCKET = "bucket";
  process.env.SQS_QUEUE_URL = "queue";
  process.env.DYNAMO_TABLE = "gnp-test-app";
  process.env.ANALYZER_BASE_URL = "https://analyzer.example/";
  process.env.ANALYZER_API_KEY = "test-key";
});

describe("translateArtifact", () => {
  it("asks for the missing locales once and writes the merged map onto every copy", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
          translations: spanish,
        },
        {
          userFriendlyLabel: tent.user_friendly_label,
          explanation: tent.description,
        },
      ],
      conditions: [
        {
          pk: "SITE#site-1",
          sk: "ASSESSMENT#chk_01-art_1#COND#001-litter",
          userFriendlyLabel: trash.user_friendly_label,
          description: trash.description,
          translations: { language: "es", ...spanish.es },
          taskIds: ["task-1"],
        },
        {
          // Another artifact whose id shares the prefix: must be ignored.
          pk: "SITE#site-1",
          sk: "ASSESSMENT#chk_01-art_10#COND#001-litter",
          userFriendlyLabel: trash.user_friendly_label,
          description: trash.description,
          taskIds: ["task-other"],
        },
      ],
      tasks: [
        {
          pk: "SITE#site-1",
          sk: "TASK#task-1",
          userFriendlyLabel: trash.user_friendly_label,
          description: trash.description,
        },
      ],
    });
    translate.mockResolvedValue({
      items: [
        {
          id: "0",
          translations: {
            fil: everything.fil,
            vi: everything.vi,
            "zh-Hant": everything["zh-Hant"],
          },
        },
        { id: "1", translations: everything },
      ],
    });

    const result = await translateArtifact(msg, {
      client: /** @type {any} */ ({ translate }),
      dynamoTable: "gnp-test-app",
    });

    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith({
      items: [
        { id: "0", ...trash },
        { id: "1", ...tent },
      ],
      languages: ["es", "fil", "vi", "zh-Hant"],
      requestId: "chk_01#art_1#translate",
      appId: "good-neighbor-app",
    });
    expect(result).toEqual({
      requestedLocales: ["es", "fil", "vi", "zh-Hant"],
      updatedTargets: 4,
    });

    const writes = updates();
    // The condition copy and its task get the full map (legacy block merged).
    expect(writes.map((w) => w.input.Key?.sk)).toEqual([
      "ASSESSMENT#chk_01-art_1#COND#001-litter",
      "TASK#task-1",
      "CHECK#chk_01#ANALYSIS#art_1",
    ]);
    expect(writes[0].input.ExpressionAttributeValues).toEqual({
      ":translations": everything,
    });
    expect(writes[0].input.ConditionExpression).toBe("attribute_exists(sk)");
    expect(writes[1].input.ExpressionAttributeValues).toEqual({
      ":translations": everything,
    });
    // Both concerns land in ONE update on the ANALYSIS# item.
    expect(writes[2].input.UpdateExpression).toBe(
      "SET #c[0].translations = :t0, #c[1].translations = :t1",
    );
    expect(writes[2].input.ExpressionAttributeValues).toEqual({
      ":t0": everything,
      ":t1": everything,
    });
  });

  it("makes no call and no writes when every copy already has every locale", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
          translations: everything,
        },
      ],
    });

    const result = await translateArtifact(
      { ...msg, items: [trash] },
      {
        client: /** @type {any} */ ({ translate }),
        dynamoTable: "gnp-test-app",
      },
    );

    expect(translate).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
    expect(result).toEqual({ requestedLocales: [], updatedTargets: 0 });
  });

  it("shares locales one copy already holds without asking the service for them", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
          translations: everything,
        },
      ],
      conditions: [
        {
          pk: "SITE#site-1",
          sk: "ASSESSMENT#chk_01-art_1-2#COND#001-litter",
          userFriendlyLabel: trash.user_friendly_label,
          description: trash.description,
          translations: spanish,
          taskIds: [],
        },
      ],
    });

    await translateArtifact(
      { ...msg, items: [trash] },
      {
        client: /** @type {any} */ ({ translate }),
        dynamoTable: "gnp-test-app",
      },
    );

    expect(translate).not.toHaveBeenCalled();
    const writes = updates();
    expect(writes).toHaveLength(1);
    expect(writes[0].input.Key?.sk).toBe(
      "ASSESSMENT#chk_01-art_1-2#COND#001-litter",
    );
    expect(writes[0].input.ExpressionAttributeValues).toEqual({
      ":translations": everything,
    });
  });

  it("skips text that no stored copy matches any more", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: "Edited label",
          explanation: "Edited description",
        },
      ],
    });

    await translateArtifact(
      { ...msg, items: [trash] },
      {
        client: /** @type {any} */ ({ translate }),
        dynamoTable: "gnp-test-app",
      },
    );

    expect(translate).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it("stores a partial service answer and ignores malformed entries", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
        },
      ],
    });
    translate.mockResolvedValue({
      items: [
        {
          id: "0",
          translations: {
            es: spanish.es,
            vi: { user_friendly_label: "" },
            fil: "nope",
          },
        },
      ],
    });

    await translateArtifact(
      { ...msg, items: [trash] },
      {
        client: /** @type {any} */ ({ translate }),
        dynamoTable: "gnp-test-app",
      },
    );

    const writes = updates();
    expect(writes).toHaveLength(1);
    expect(writes[0].input.ExpressionAttributeValues).toEqual({
      ":t0": spanish,
    });
  });

  it("consumes a permanent analyzer failure and leaves English in place", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
        },
      ],
    });
    translate.mockRejectedValue(
      new AnalyzerError("bad request", {
        status: 400,
        code: "invalid_request",
      }),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = await translateArtifact(
        { ...msg, items: [trash] },
        {
          client: /** @type {any} */ ({ translate }),
          dynamoTable: "gnp-test-app",
        },
      );
      expect(result.updatedTargets).toBe(0);
      expect(updates()).toHaveLength(0);
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  it("rethrows a retryable analyzer failure so SQS redelivers", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
        },
      ],
    });
    translate.mockRejectedValue(
      new AnalyzerError("busy", { status: 503, retryable: true }),
    );

    await expect(
      translateArtifact(
        { ...msg, items: [trash] },
        {
          client: /** @type {any} */ ({ translate }),
          dynamoTable: "gnp-test-app",
        },
      ),
    ).rejects.toThrow("busy");
  });

  it("rejects a malformed message", async () => {
    await expect(
      translateArtifact(/** @type {any} */ ({ type: "translate_artifact" }), {
        client: /** @type {any} */ ({ translate }),
        dynamoTable: "gnp-test-app",
      }),
    ).rejects.toThrow(/malformed/);
  });
});

describe("handler", () => {
  it("reports only the failed records for redelivery", async () => {
    mockStore({
      concerns: [
        {
          userFriendlyLabel: trash.user_friendly_label,
          explanation: trash.description,
        },
      ],
    });
    translate
      .mockResolvedValueOnce({ items: [{ id: "0", translations: everything }] })
      .mockRejectedValueOnce(
        new AnalyzerError("busy", { status: 503, retryable: true }),
      );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await /** @type {any} */ (
        handler(
          /** @type {any} */ ({
            Records: [
              {
                messageId: "m1",
                body: JSON.stringify({ ...msg, items: [trash] }),
              },
              {
                messageId: "m2",
                body: JSON.stringify({ ...msg, items: [trash] }),
              },
            ],
          }),
          /** @type {any} */ ({}),
          () => {},
        )
      );
      expect(createAnalyzerClient).toHaveBeenCalledWith({
        baseUrl: "https://analyzer.example/",
        apiKey: "test-key",
      });
      expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }]);
    } finally {
      error.mockRestore();
    }
  });
});
