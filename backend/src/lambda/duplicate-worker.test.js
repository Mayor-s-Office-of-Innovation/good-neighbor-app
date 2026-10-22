import { beforeEach, it, expect, vi } from "vitest";
import {
  analysisRevision,
  projectionKey,
} from "../analysis/duplicates/jobs.js";

const state = vi.hoisted(() => ({
  readImage: vi.fn(),
  records: new Map(),
  writes:
    /** @type {(import("@aws-sdk/lib-dynamodb").TransactWriteCommandInput | import("@aws-sdk/lib-dynamodb").PutCommandInput)[]} */ ([]),
  sends: /** @type {object[]} */ ([]),
  compare:
    /** @type {import("vitest").Mock<import("../analysis/duplicates/image-matcher.js").Compare>} */ (
      vi.fn()
    ),
}));
vi.mock("../db.js", () => ({
  ddb: {
    send: async (
      /** @type {import("@aws-sdk/lib-dynamodb").GetCommand | import("@aws-sdk/lib-dynamodb").PutCommand | import("@aws-sdk/lib-dynamodb").QueryCommand | import("@aws-sdk/lib-dynamodb").TransactWriteCommand} */ command,
    ) => {
      const input = command.input;
      if ("Key" in input) return { Item: state.records.get(input.Key?.sk) };
      if ("KeyConditionExpression" in input) {
        const values = input.ExpressionAttributeValues;
        return {
          Items: [...state.records.values()].filter(
            (row) =>
              row.sk?.startsWith("DUP_OBSERVATION#") &&
              row.sk >= values?.[":start"] &&
              row.sk <= values?.[":end"],
          ),
        };
      }
      if ("TransactItems" in input) {
        state.writes.push(input);
        for (const entry of input.TransactItems ?? [])
          if (entry.Put?.Item)
            state.records.set(entry.Put.Item.sk, entry.Put.Item);
        return {};
      }
      if ("Item" in input && input.Item) {
        state.writes.push(input);
        state.records.set(input.Item.sk, input.Item);
      }
      return {};
    },
  },
}));
vi.mock("../s3.js", () => ({
  headObject: async () => ({ lastModified: new Date() }),
  getObjectBytes: state.readImage,
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return {};
    }
  },
  PutObjectCommand: class {
    constructor(/** @type {object} */ input) {
      this.input = input;
    }
  },
}));
vi.mock("../analysis/api-key.js", () => ({
  getAnalyzerApiKey: async () => "private-test-key",
}));
vi.mock("../analysis/duplicates/image-features.js", () => ({
  prepareImage: async () => ({
    image: { content_type: "image/jpeg", base64: "image" },
    fingerprint: "fingerprint",
    perceptualHash: "0".repeat(64),
  }),
}));
vi.mock("../analysis/duplicates/image-matcher.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createComparisonClient: () => state.compare,
}));
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class {
    async send(/** @type {{input:object}} */ command) {
      state.sends.push(command.input);
      return {};
    }
  },
  SendMessageCommand: class {
    constructor(/** @type {object} */ input) {
      this.input = input;
    }
  },
}));
import { handler } from "./duplicate-worker.js";

beforeEach(() => {
  state.readImage
    .mockReset()
    .mockResolvedValue({ bytes: Buffer.from("image"), contentLength: 5 });
  state.records.clear();
  state.writes = [];
  state.sends = [];
  state.compare.mockReset();
  process.env.DYNAMO_TABLE = "test";
  process.env.S3_UPLOAD_BUCKET = "uploads";
  process.env.DUPLICATE_QUEUE_URL = "queue";
  process.env.DUPLICATE_ANALYZER_BASE_URL = "https://analyzer.test/";
});
/** @returns {{current:Record<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue>,target:Record<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue>,projection:Record<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue>,event:{Records:{messageId:string,body:string}[]}}} */
function setup() {
  const current = {
    pk: "SITE#site",
    sk: "CHECK#source#ANALYSIS#photo",
    status: "analyzed",
    analysisId: "source-analysis",
    checkId: "source",
    artifactId: "photo",
    analyzedAt: "2026-10-14T10:01:00Z",
    concerns: [
      {
        conditionId: "s1",
        category: "test-category",
        rating: 2,
        explanation: "pile",
      },
    ],
  };
  const target = {
    ...current,
    sk: "CHECK#target#ANALYSIS#photo",
    analysisId: "target-analysis",
    checkId: "target",
    analyzedAt: "2026-10-14T09:00:00Z",
    concerns: [
      {
        conditionId: "t1",
        category: "test-category",
        rating: 2,
        explanation: "pile",
      },
    ],
  };
  const projection = {
    ...projectionKey("site", "2026-10-14T09:00:00Z", "target:photo"),
    id: "target:photo",
    sourceId: "target:photo",
    siteId: "site",
    checkId: "target",
    artifactId: "photo",
    revision: analysisRevision(target),
    observedAt: "2026-10-14T09:00:00.000Z",
    availableAt: target.analyzedAt,
    conditions: [{ id: "t1", description: "pile" }],
    s3Key: "site/target",
    contentType: "image/jpeg",
  };
  state.records.set("DUP_COVERAGE", { coverageFrom: "2026-10-01T00:00:00Z" });
  state.records.set(current.sk, current);
  state.records.set(target.sk, target);
  state.records.set("CHECK#target#ART#photo", {
    s3Key: "site/target",
    capturedAt: "2026-10-14T09:00:00Z",
  });
  state.records.set(projection.sk, projection);
  state.records.set("CHECK#source#ART#photo", {
    capturedAt: "2026-10-14T10:00:00Z",
    s3Key: "site/source",
    contentType: "image/jpeg",
  });
  state.compare.mockImplementation(async (request) => ({
    comparison_version: "v1",
    model: { model_id: "test" },
    comparisons: request.candidates.map((c) => ({
      candidate_id: c.id,
      verdict: "same_issue",
      evidence_strength: "strong",
      reason: "Matching distinctive pile",
      source_region: "pile",
      candidate_region: "pile",
      evidence: {
        visual_identity: "clear",
        issue_mapping: request.mode === "context" ? "clear" : "none",
        matching_features: ["Distinctive object"],
        visible_differences: ["Different object"],
        contradictions: [],
        description_conflict: "none",
        continuity_concern: "none",
      },
      condition_matches:
        request.mode === "context"
          ? [
              {
                evidence: {
                  visual_identity: "clear",
                  issue_mapping: "clear",
                  matching_features: ["Distinctive object"],
                  visible_differences: [],
                  contradictions: [],
                  description_conflict: "none",
                  continuity_concern: "none",
                },
                source_condition_id:
                  request.source.context?.conditions[0]?.id ?? "missing-source",
                candidate_condition_id:
                  c.context?.conditions[0]?.id ?? "missing-candidate",
              },
            ]
          : [],
    })),
  }));
  return {
    current,
    target,
    projection,
    event: {
      Records: [
        {
          messageId: "message",
          body: JSON.stringify({
            siteId: "site",
            checkId: "source",
            artifactId: "photo",
            revision: analysisRevision(current),
          }),
        },
      ],
    },
  };
}
it("matches late-available prior captures without waiting for client guidance; writes atomic target checks", async () => {
  const { event, current } = setup();
  const result = await handler(
    /** @type {import("aws-lambda").SQSEvent} */ (event),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [] });
  expect(state.compare).toHaveBeenCalledTimes(1);
  const saved = state.records.get(
    `DUP_RESULT#source:photo#${analysisRevision(current)}`,
  );
  const issueKey = `DUP_ISSUE#source:photo#${analysisRevision(current)}#s1`;
  expect(state.records.get(issueKey).possibleDuplicate).toBe(true);
  const puts = state.writes.flatMap((w) =>
    "TransactItems" in w
      ? (w.TransactItems ?? []).map((e) => e.Put?.Item?.sk)
      : [w.Item?.sk],
  );
  expect(puts.indexOf(issueKey)).toBeLessThan(
    puts.indexOf(`DUP_RESULT#source:photo#${analysisRevision(current)}`),
  );
  expect(saved.latency.totalMs).toBeGreaterThanOrEqual(0);
  expect(saved.shadow).toBe(false);
  expect(saved.conditionResults[0].duplicateOf.conditionId).toBe("t1");
  expect(
    state.writes.some(
      (input) =>
        "TransactItems" in input &&
        input.TransactItems?.some(
          (entry) =>
            entry.ConditionCheck?.Key?.sk === "CHECK#target#ANALYSIS#photo",
        ),
    ),
  ).toBe(true);
});
it("a target amendment during comparison retries duplicate work instead of publishing a stale flag", async () => {
  const { event, target } = setup();
  const compare = state.compare.getMockImplementation();
  if (!compare) throw new Error("Missing test comparison implementation");
  state.compare.mockImplementation(async (request) => {
    const result = await compare(request);
    state.records.set(target.sk, {
      ...target,
      concerns: [{ ...target.concerns[0], explanation: "changed" }],
    });
    return result;
  });
  const result = await handler(
    /** @type {import("aws-lambda").SQSEvent} */ (event),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
  expect(result).toEqual({
    batchItemFailures: [{ itemIdentifier: "message" }],
  });
  expect(
    [...state.records.values()].some(
      (row) =>
        row.sk?.startsWith("DUP_RESULT#") && row.possibleDuplicate === true,
    ),
  ).toBe(false);
});
it("an old source revision does no model work", async () => {
  const { event, current } = setup();
  state.records.set(current.sk, { ...current, concerns: [] });
  const result = await handler(
    /** @type {import("aws-lambda").SQSEvent} */ (event),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [] });
  expect(state.compare).not.toHaveBeenCalled();
});

it("does not publish incremental positives for an artifact removed during comparison", async () => {
  const { event } = setup();
  const compare = state.compare.getMockImplementation();
  if (!compare) throw new Error("Missing comparison stub");
  state.compare.mockImplementation(async (request) => {
    const response = await compare(request);
    state.records.delete("CHECK#target#ART#photo");
    return response;
  });
  await handler(
    /** @type {import('aws-lambda').SQSEvent} */ (event),
    /** @type {import('aws-lambda').Context} */ ({}),
    () => {},
  );
  expect(
    [...state.records.keys()].some((key) => key.startsWith("DUP_ISSUE#")),
  ).toBe(false);
  expect(
    [...state.records.values()].some(
      (row) =>
        row.sk?.startsWith("DUP_RESULT#") && row.possibleDuplicate === true,
    ),
  ).toBe(false);
});

it("bootstraps missing candidate history without calling normal analysis", async () => {
  const { event, current } = setup();
  state.records.delete("DUP_COVERAGE");
  await handler(
    /** @type {import("aws-lambda").SQSEvent} */ (event),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
  const saved = state.records.get(
    `DUP_RESULT#source:photo#${analysisRevision(current)}`,
  );
  expect(state.records.get("DUP_COVERAGE")?.coverageFrom).toBeDefined();
  expect(saved.status).toBe("evaluated");
});

it("prepares newly registered uploads independently before any analysis exists", async () => {
  state.records.set("CHECK#source#ART#photo", {
    s3Key: "checks/site/source/photo",
    contentType: "image/jpeg",
  });
  const result = await handler(
    /** @type {import('aws-lambda').SQSEvent} */ (
      /** @type {unknown} */ ({
        Records: [
          {
            messageId: "prepare",
            body: JSON.stringify({
              siteId: "site",
              checkId: "source",
              artifactId: "photo",
              prepareOnly: true,
            }),
          },
        ],
      })
    ),
    /** @type {import('aws-lambda').Context} */ (/** @type {unknown} */ ({})),
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [] });
  expect(state.compare).not.toHaveBeenCalled();
  expect(state.writes).toHaveLength(0);
});

it("completes failed comparisons as frontend no-match with separate diagnostics", async () => {
  const { event, current } = setup();
  state.compare.mockRejectedValue(new Error("temporary outage"));
  const result = await handler(
    /** @type {import("aws-lambda").SQSEvent} */ (event),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [] });
  const saved = state.records.get(
    `DUP_RESULT#source:photo#${analysisRevision(current)}`,
  );
  expect(saved.processingState).toBe("complete");
  expect(saved.conditionResults[0]).toMatchObject({
    possibleDuplicate: false,
    assessmentOutcome: "no_match_with_failures",
    failedCandidateCount: 1,
  });
});

it("builds a missing prepared image and continues matching", async () => {
  const { event } = setup();
  state.readImage.mockImplementation(async ({ key }) => {
    if (key.startsWith("duplicate-prepared/"))
      throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return { bytes: Buffer.from("image"), contentLength: 5 };
  });
  const result = await handler(
    /** @type {import("aws-lambda").SQSEvent} */ (event),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
  expect(result).toEqual({ batchItemFailures: [] });
  expect(state.compare).toHaveBeenCalled();
});

it("retries actual cache permission errors and emits safe job diagnostics", async () => {
  const { event } = setup();
  state.readImage.mockRejectedValue(
    Object.assign(new Error("private image location"), {
      name: "AccessDenied",
    }),
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await handler(
      /** @type {import("aws-lambda").SQSEvent} */ (event),
      /** @type {import("aws-lambda").Context} */ ({}),
      () => {},
    );
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "message" }],
    });
    expect(state.compare).not.toHaveBeenCalled();
    const logs = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "duplicate_worker_failed",
        errorName: "AccessDenied",
        siteId: "site",
        observationId: "source:photo",
        messageId: "message",
        jobKind: "compare",
      }),
    );
    expect(JSON.stringify(logs)).not.toContain("private image location");
  } finally {
    log.mockRestore();
  }
});
