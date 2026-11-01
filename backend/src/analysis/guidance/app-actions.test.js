import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

const {
  createAnalyzerClient,
  downscaleImage,
  getAnalyzerApiKey,
  getObjectBytes,
  create311MediaLink,
  send,
} = vi.hoisted(() => ({
  createAnalyzerClient: vi.fn(),
  downscaleImage: vi.fn(async (bytes) => ({
    bytes,
    contentType: "image/jpeg",
  })),
  getAnalyzerApiKey: vi.fn(),
  getObjectBytes: vi.fn(),
  create311MediaLink: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../db.js", () => ({ ddb: { send } }));
vi.mock("../../s3.js", () => ({ getObjectBytes }));
vi.mock("../../integrations/sf311-media.js", () => ({ create311MediaLink }));
vi.mock("../../media/downscale.js", () => ({ downscaleImage }));
vi.mock("../api-key.js", () => ({ getAnalyzerApiKey }));
vi.mock("../analyzer-client.js", () => ({ createAnalyzerClient }));

import {
  eligibleTicketsForClosure,
  mergeAppActionResults,
  executeAppActions,
  initialAppActionStatus,
  is311SubmissionEnabled,
  summarizeAppActionResults,
} from "./app-actions.js";

// A submitted create_311_ticket result for an informational (agency-76)
// ticket — the only kind this app closes.
const SUBMITTED_311_RESULT = {
  code: "create_311_ticket",
  status: "submitted",
  payload: {
    tickets: [
      {
        serviceCode: "1.1.4.7.20.0",
        responsibleAgency: "76",
        sourceRequestId: "task-1-1147200",
        srNum: "2000008106",
        attachments: [],
      },
    ],
  },
  externalId: "2000008106",
  recordedAt: "2026-08-18T11:00:00.000Z",
};

describe("app action execution", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

  it("checkpoints automatic creation before and after City acceptance and refuses uncertain retries", async () => {
    const env = {
      GNP_311_SUBMISSION_ENABLED: "true",
      DYNAMO_TABLE: "table",
      S3_UPLOAD_BUCKET: "bucket",
      SQS_QUEUE_URL: "queue",
      SF311_CREATESR_URL: "https://hub.example/createsr",
      SF311_BASIC_AUTH_USER: "user",
      SF311_BASIC_AUTH_PASS: "pass",
    };
    /** @type {import("./app-actions.js").AppActionResult[]} */
    const checkpoints = [];
    const fetchImpl = vi.fn(async () => {
      expect(checkpoints[0].reason).toBe("creation_pending");
      return new Response(
        JSON.stringify({ data: { return_code: "0", SRNum: "2000008106" } }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchImpl);
    const actions = [
      {
        code: "create_311_ticket",
        payload: {
          executionTrigger: "task_created",
          serviceCodeOrAction: "1.1.4.7.20.0",
          responsibleAgencyCode: "76",
        },
      },
    ];
    const options = {
      env,
      tableName: "table",
      siteId: "site",
      now,
      trigger: /** @type {const} */ ("task_created"),
      task: { taskId: "task", location: { latitude: 37.7, longitude: -122.4 } },
      onCheckpoint: async (
        /** @type {import("./app-actions.js").AppActionResult} */ result,
      ) => {
        checkpoints.push(result);
      },
    };
    try {
      const results = await executeAppActions(actions, options);
      expect(results[0].status).toBe("submitted");
      expect(checkpoints[1]).toMatchObject({
        reason: "attachments_pending",
        payload: { tickets: [{ srNum: "2000008106" }] },
      });
      const uncertain = await executeAppActions(actions, {
        ...options,
        priorResults: [checkpoints[0]],
      });
      expect(uncertain[0].status).toBe("failed");
      expect(fetchImpl).toHaveBeenCalledOnce();
      await executeAppActions(actions, {
        ...options,
        priorResults: [checkpoints[1]],
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records legacy phone actions without routing to a phone app", async () => {
    expect(
      await executeAppActions(
        [{ code: "open_phone", payload: { phoneNumber: "911" } }],
        { now },
      ),
    ).toEqual([
      {
        code: "open_phone",
        status: "recorded",
        payload: { phoneNumber: "911" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("skips 311 submission unless the feature flag is enabled", async () => {
    expect(
      is311SubmissionEnabled({ GNP_311_SUBMISSION_ENABLED: "false" }),
    ).toBe(false);
    expect(
      await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
          },
        ],
        { env: {}, now, taskId: "task-1" },
      ),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "skipped",
        reason: "feature_disabled",
        payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("runs only app actions for the requested trigger", async () => {
    const actions = [
      {
        code: "create_311_ticket",
        payload: {
          serviceCodeOrAction: "1.1.4.7.20.0",
          executionTrigger: "task_created",
        },
      },
      {
        code: "open_phone",
        payload: { phoneNumber: "911" },
      },
    ];

    expect(
      await executeAppActions(actions, {
        env: { GNP_311_SUBMISSION_ENABLED: "false" },
        now,
        trigger: "user_confirmed",
      }),
    ).toEqual([
      {
        code: "open_phone",
        status: "recorded",
        payload: { phoneNumber: "911" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);

    expect(
      await executeAppActions(actions, {
        env: { GNP_311_SUBMISSION_ENABLED: "false" },
        now,
        trigger: "task_created",
      }),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "skipped",
        reason: "feature_disabled",
        payload: {
          serviceCodeOrAction: "1.1.4.7.20.0",
          executionTrigger: "task_created",
        },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("files again after HUB rejects CreateSR, but not after a 5xx", async () => {
    const env = {
      GNP_311_SUBMISSION_ENABLED: "true",
      DYNAMO_TABLE: "table",
      S3_UPLOAD_BUCKET: "bucket",
      SQS_QUEUE_URL: "queue",
      SF311_CREATESR_URL: "https://hub.example/createsr",
      SF311_BASIC_AUTH_USER: "user",
      SF311_BASIC_AUTH_PASS: "pass",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { return_code: "4001" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    vi.stubGlobal("fetch", fetchImpl);
    send.mockResolvedValue({ Items: [] });
    /** @type {import("./app-actions.js").AppActionResult[]} */
    const checkpoints = [];
    const actions = [
      {
        code: "create_311_ticket",
        payload: {
          executionTrigger: "user_confirmed",
          serviceCodeOrAction: "1.1.4.7.20.0",
          responsibleAgencyCode: "76",
        },
      },
    ];
    const options = {
      env,
      tableName: "table",
      siteId: "site",
      now,
      trigger: /** @type {const} */ ("user_confirmed"),
      task: { taskId: "task", location: { latitude: 37.7, longitude: -122.4 } },
      onCheckpoint: async (
        /** @type {import("./app-actions.js").AppActionResult} */ result,
      ) => {
        checkpoints.push(result);
      },
    };
    try {
      const [rejected] = await executeAppActions(actions, options);
      expect(rejected).toMatchObject({
        status: "failed",
        reason: "4001",
        payload: { tickets: [{ creationState: "rejected" }] },
      });
      // Retry from the last durable checkpoint, as if the run stopped before
      // the worker recorded the returned result.
      const saved = checkpoints.at(-1);
      expect(saved).toMatchObject({
        reason: "creation_rejected",
        payload: { tickets: [{ creationState: "rejected" }] },
      });
      const [serverError] = await executeAppActions(actions, {
        ...options,
        priorResults: saved ? [saved] : [],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(serverError.payload?.tickets).toEqual([]);
      const [uncertain] = await executeAppActions(actions, {
        ...options,
        priorResults: [checkpoints.at(-1), serverError].filter(
          (result) => result !== undefined,
        ),
      });
      expect(uncertain.reason).toBe(
        "sf311_creation_uncertain_requires_reconciliation",
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("treats blank or 0,0 coordinates as no location", async () => {
    const actions = [
      {
        code: "create_311_ticket",
        payload: {
          serviceCodeOrAction: "1.1.4.7.20.0",
          responsibleAgencyCode: "76",
        },
      },
    ];
    send.mockResolvedValueOnce({
      Item: { location: { latitude: null, longitude: "" } },
    });
    try {
      const [result] = await executeAppActions(actions, {
        env: {
          GNP_311_SUBMISSION_ENABLED: "true",
          DYNAMO_TABLE: "table",
          S3_UPLOAD_BUCKET: "bucket",
          SQS_QUEUE_URL: "queue",
          SF311_CREATESR_URL: "https://hub.example/createsr",
          SF311_BASIC_AUTH_USER: "user",
          SF311_BASIC_AUTH_PASS: "pass",
        },
        now,
        tableName: "table",
        siteId: "site",
        task: {
          taskId: "task",
          source: {
            latitude: 0,
            longitude: 0,
            positionDescriptor: "perimeter",
          },
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        reason: "missing_location",
      });
      expect(send).toHaveBeenCalledOnce();
    } finally {
      send.mockReset();
    }
  });

  it("logs when 311 falls back to the site point, without coordinates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    send
      .mockResolvedValueOnce({
        Item: { location: { latitude: 37.7, longitude: -122.4 } },
      })
      .mockResolvedValue({ Items: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { return_code: "0", SRNum: "2000008106" } }),
            { status: 200 },
          ),
      ),
    );
    const run = (/** @type {Record<string, unknown>} */ task) =>
      executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              responsibleAgencyCode: "76",
            },
          },
        ],
        {
          env: {
            GNP_311_SUBMISSION_ENABLED: "true",
            DYNAMO_TABLE: "table",
            S3_UPLOAD_BUCKET: "bucket",
            SQS_QUEUE_URL: "queue",
            SF311_CREATESR_URL: "https://hub.example/createsr",
            SF311_BASIC_AUTH_USER: "user",
            SF311_BASIC_AUTH_PASS: "pass",
          },
          now,
          tableName: "table",
          siteId: "site",
          task,
        },
      );
    const fallbackLines = () =>
      log.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("LocationFallbackToSite"));
    try {
      await run({ taskId: "task", checkId: "check" });
      expect(fallbackLines()).toHaveLength(1);
      expect(JSON.parse(fallbackLines()[0])).toMatchObject({
        marker: "LocationFallbackToSite",
        siteId: "site",
        taskId: "task",
        checkId: "check",
      });
      expect(fallbackLines()[0]).not.toContain("37.7");

      await run({
        taskId: "task-2",
        location: { latitude: 37.78, longitude: -122.41 },
      });
      expect(fallbackLines()).toHaveLength(1);
    } finally {
      log.mockRestore();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  /**
   * File one 311 ticket for a task with the given source photos.
   * @param {string[]} sourceArtifactIds
   * @param {Record<string, unknown>} [source]
   * @param {Record<string, unknown>} [location] the task's top-level location
   * @returns {Promise<{ result: Record<string, unknown>, sent: string }>}
   */
  async function fileWithPhotos(sourceArtifactIds, source = {}, location) {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { return_code: "0", SRNum: "2000008106" } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const [result] = await executeAppActions(
      [
        {
          code: "create_311_ticket",
          payload: {
            serviceCodeOrAction: "1.1.4.7.20.0",
            responsibleAgencyCode: "76",
          },
        },
      ],
      {
        env: {
          GNP_311_SUBMISSION_ENABLED: "true",
          DYNAMO_TABLE: "table",
          S3_UPLOAD_BUCKET: "bucket",
          SQS_QUEUE_URL: "queue",
          SF311_CREATESR_URL: "https://hub.example/createsr",
          SF311_BASIC_AUTH_USER: "user",
          SF311_BASIC_AUTH_PASS: "pass",
        },
        now,
        tableName: "table",
        siteId: "site",
        task: {
          taskId: "task",
          checkId: "check",
          sourceArtifactIds,
          source,
          ...(location ? { location } : {}),
        },
      },
    );
    return { result, sent: JSON.stringify(fetchImpl.mock.calls) };
  }

  it("files 311 at the most accurate of several source photos", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    send.mockResolvedValueOnce({
      Items: [
        {
          artifactId: "artifact-1",
          latitude: 37.7001,
          longitude: -122.4001,
          accuracyMeters: 120,
        },
        {
          artifactId: "artifact-2",
          latitude: 37.7793,
          longitude: -122.4192,
          accuracyMeters: 9,
        },
      ],
    });
    try {
      const { result, sent } = await fileWithPhotos([
        "artifact-1",
        "artifact-2",
      ]);
      expect(result.status).toBe("submitted");
      expect(sent).toContain("37.7793");
      expect(sent).not.toContain("37.7001");
    } finally {
      log.mockRestore();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("files 311 at a photo's fix that is more accurate than the task's", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    send.mockResolvedValueOnce({
      Items: [
        {
          artifactId: "artifact-1",
          latitude: 37.7793,
          longitude: -122.4192,
          accuracyMeters: 8,
        },
      ],
    });
    try {
      const { result, sent } = await fileWithPhotos(["artifact-1"], {
        latitude: 37.7001,
        longitude: -122.4001,
        accuracyMeters: 400,
      });
      expect(result.status).toBe("submitted");
      expect(sent).toContain("37.7793");
      expect(sent).not.toContain("37.7001");
    } finally {
      log.mockRestore();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("doesn't score a task's top-level location with its source accuracy", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    send.mockResolvedValueOnce({
      Items: [
        {
          artifactId: "artifact-1",
          latitude: 37.7793,
          longitude: -122.4192,
          accuracyMeters: 8,
        },
      ],
    });
    try {
      const { sent } = await fileWithPhotos(
        ["artifact-1"],
        {
          accuracyMeters: 5,
        },
        { latitude: 37.7001, longitude: -122.4001 },
      );
      expect(sent).toContain("37.7793");
      expect(sent).not.toContain("37.7001");
    } finally {
      log.mockRestore();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("files 311 at a photo on a later page of the check's artifacts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    send
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { sk: "page-1" } })
      .mockResolvedValueOnce({
        Items: [
          { artifactId: "artifact-1", latitude: 37.7793, longitude: -122.4192 },
        ],
      });
    try {
      const { result, sent } = await fileWithPhotos(["artifact-1"]);
      expect(result.status).toBe("submitted");
      expect(sent).toContain("37.7793");
    } finally {
      log.mockRestore();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("files 311 at a location sent after the task was written", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    send.mockResolvedValueOnce({
      Items: [
        {
          artifactId: "artifact-1",
          text: "Trash by the door",
          latitude: 37.7793,
          longitude: -122.4192,
          accuracyMeters: 9,
        },
      ],
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { return_code: "0", SRNum: "2000008106" } }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const [result] = await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "1.1.4.7.20.0",
              responsibleAgencyCode: "76",
            },
          },
        ],
        {
          env: {
            GNP_311_SUBMISSION_ENABLED: "true",
            DYNAMO_TABLE: "table",
            S3_UPLOAD_BUCKET: "bucket",
            SQS_QUEUE_URL: "queue",
            SF311_CREATESR_URL: "https://hub.example/createsr",
            SF311_BASIC_AUTH_USER: "user",
            SF311_BASIC_AUTH_PASS: "pass",
          },
          now,
          tableName: "table",
          siteId: "site",
          task: {
            taskId: "task",
            checkId: "check",
            sourceArtifactIds: ["artifact-1"],
            source: {},
          },
        },
      );
      expect(result.status).toBe("submitted");
      expect(JSON.stringify(fetchImpl.mock.calls)).toContain("37.7793");
      // One read of the artifact; the site's point is never needed.
      expect(send).toHaveBeenCalledOnce();
      expect(
        log.mock.calls.some(([line]) =>
          String(line).includes("LocationFallbackToSite"),
        ),
      ).toBe(false);
    } finally {
      log.mockRestore();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("records a failed 311 submission when config is incomplete", async () => {
    expect(
      await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
          },
        ],
        {
          env: { GNP_311_SUBMISSION_ENABLED: "true" },
          now,
          taskId: "task-1",
        },
      ),
    ).toEqual([
      {
        code: "create_311_ticket",
        status: "failed",
        reason: expect.stringContaining(
          "Missing required environment variable",
        ),
        payload: { serviceCodeOrAction: "1.1.4.7.20.0" },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("records safe diagnostics for SF311 submission failures", async () => {
    send.mockResolvedValueOnce({
      Item: {
        location: {
          latitude: 37.76656393517443,
          longitude: -122.4213267021692,
        },
      },
    });
    send.mockResolvedValueOnce({ Items: [] });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            return_code: "4001",
            return_message: "NatureofRequest is invalid",
            password: "do-not-store",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      expect(
        await executeAppActions(
          [
            {
              code: "create_311_ticket",
              payload: {
                serviceCodeOrAction: "1.1.4.7.20.0",
                responsibleAgencyCode: "",
              },
            },
          ],
          {
            env: {
              GNP_311_SUBMISSION_ENABLED: "true",
              DYNAMO_TABLE: "table",
              S3_UPLOAD_BUCKET: "bucket",
              SQS_QUEUE_URL: "queue",
              SF311_CREATESR_URL: "https://hub.example.test/createsr",
              SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
              SF311_BASIC_AUTH_USER: "user",
              SF311_BASIC_AUTH_PASS: "pass",
            },
            now,
            taskId: "task-1",
            tableName: "table",
            siteId: "site-1",
            task: { taskId: "task-1", description: "Trash" },
          },
        ),
      ).toEqual([
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "4001",
          payload: {
            serviceCodeOrAction: "1.1.4.7.20.0",
            responsibleAgencyCode: "",
            tickets: [],
          },
          externalId: "",
          diagnostics: {
            integration: "sf311",
            status: 200,
            code: "4001",
            request: {
              SourceAgency: "76",
              SourceRequestID: "task-1-1147200",
              SourceOperator: "Good Neighbor App",
              ResponsibleAgency: "",
              ResponsibleAgencyRequestID: "",
              SourceAgencyReceiveDate: "2026-08-18 12:00:00",
              TransferToResponsiblAgencyDate: "",
              PublicVisibilityIndicator: "0",
              CustomerName: "",
              CustomerPhone: "",
              CustomerAddress1: "",
              CustomerAddress2: "",
              CustomerCity: "",
              CustomerState: "",
              CustomerZip: "",
              CustomerCountry: "",
              CustomerEmail: "",
              CallbackRequestedIndicator: "0",
              CallbackNotes: "",
              NatureofRequest: "1.1.4.7.20.0",
              ProblemDescription: "Trash",
              PriorityType: "",
              EmergencyType: "",
              Status: "",
              LinkID: "",
              LocationPointofInterest: "",
              LocationStreetNumber: "",
              LocationStreetName: "",
              LocationCrossStreet1: "",
              LocationCrossStreet2: "",
              LocationDescription: "",
              EasID: "",
              BlockLot: "",
              CNN: "",
              DeptAssetType: "",
              DeptAssetID: "",
              Xcoordinate: "",
              Ycoordinate: "",
              Latitude: "37.76656393517443",
              Longitude: "-122.4213267021692",
            },
            body: {
              data: {
                return_code: "4001",
                return_message: "NatureofRequest is invalid",
                password: "[redacted]",
              },
            },
          },
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]);
    } finally {
      send.mockReset();
      getObjectBytes.mockReset();
      create311MediaLink.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("finds classifier evidence on a later page of the check's artifacts", async () => {
    send
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { sk: "page-1" } })
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      });
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("image"),
      contentType: "image/jpeg",
    });
    downscaleImage.mockResolvedValueOnce({
      bytes: Buffer.from("resized-image"),
      contentType: "image/jpeg",
    });
    getAnalyzerApiKey.mockResolvedValueOnce("analyzer-key");
    const classifyEvidence = vi.fn().mockResolvedValueOnce({ labels: [] });
    createAnalyzerClient.mockReturnValueOnce({ classifyEvidence });

    try {
      await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: { serviceCodeOrAction: "Run graffiti analysis" },
          },
        ],
        {
          env: {
            GNP_311_SUBMISSION_ENABLED: "true",
            DYNAMO_TABLE: "table",
            S3_UPLOAD_BUCKET: "bucket",
            SQS_QUEUE_URL: "queue",
            ANALYZER_BASE_URL: "https://analyzer.example.test",
            ANALYZER_API_KEY: "analyzer-key",
            SF311_CREATESR_URL: "https://hub.example.test/createsr",
            SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
            SF311_BASIC_AUTH_USER: "user",
            SF311_BASIC_AUTH_PASS: "pass",
          },
          now,
          tableName: "table",
          siteId: "site-1",
          task: {
            taskId: "task-1",
            checkId: "check-1",
            description: "Graffiti",
            sourceArtifactIds: ["artifact-1"],
          },
        },
      );
      expect(classifyEvidence).toHaveBeenCalled();
    } finally {
      send.mockReset();
    }
  });

  it("fails classifier-backed 311 actions when no service codes are produced", async () => {
    send.mockResolvedValueOnce({
      Items: [
        {
          artifactId: "artifact-1",
          s3Key: "checks/site-1/check-1/North/artifact-1",
          contentType: "image/jpeg",
        },
      ],
    });
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("image"),
      contentType: "image/jpeg",
    });
    downscaleImage.mockResolvedValueOnce({
      bytes: Buffer.from("resized-image"),
      contentType: "image/jpeg",
    });
    getAnalyzerApiKey.mockResolvedValueOnce("analyzer-key");
    const classifyEvidence = vi.fn().mockResolvedValueOnce({ labels: [] });
    createAnalyzerClient.mockReturnValueOnce({
      classifyEvidence,
    });

    try {
      expect(
        await executeAppActions(
          [
            {
              code: "create_311_ticket",
              payload: { serviceCodeOrAction: "Run graffiti analysis" },
            },
          ],
          {
            env: {
              GNP_311_SUBMISSION_ENABLED: "true",
              DYNAMO_TABLE: "table",
              S3_UPLOAD_BUCKET: "bucket",
              SQS_QUEUE_URL: "queue",
              ANALYZER_BASE_URL: "https://analyzer.example.test",
              ANALYZER_API_KEY: "analyzer-key",
              SF311_CREATESR_URL: "https://hub.example.test/createsr",
              SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
              SF311_BASIC_AUTH_USER: "user",
              SF311_BASIC_AUTH_PASS: "pass",
            },
            now,
            tableName: "table",
            siteId: "site-1",
            task: {
              taskId: "task-1",
              checkId: "check-1",
              description: "Graffiti",
              sourceArtifactIds: ["artifact-1"],
            },
          },
        ),
      ).toEqual([
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "insufficient_classifier_information",
          payload: { serviceCodeOrAction: "Run graffiti analysis" },
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]);
      expect(downscaleImage).toHaveBeenCalledWith(
        Buffer.from("image"),
        "image/jpeg",
      );
      expect(classifyEvidence).toHaveBeenCalledWith(
        expect.objectContaining({
          evidence: {
            type: "image",
            image: {
              content_type: "image/jpeg",
              base64: Buffer.from("resized-image").toString("base64"),
            },
          },
        }),
      );
    } finally {
      createAnalyzerClient.mockReset();
      getAnalyzerApiKey.mockReset();
      getObjectBytes.mockReset();
      send.mockReset();
    }
  });

  it("classifies description-only evidence and files without an attachment", async () => {
    const textArtifact = {
      artifactId: "artifact-1",
      text: "A mattress has been left on the sidewalk.",
    };
    send
      .mockResolvedValueOnce({ Items: [textArtifact] })
      .mockResolvedValueOnce({ Items: [textArtifact] });
    getAnalyzerApiKey.mockResolvedValueOnce("analyzer-key");
    const classifyEvidence = vi
      .fn()
      .mockResolvedValueOnce({ labels: ["Mattress"] });
    createAnalyzerClient.mockReturnValueOnce({ classifyEvidence });
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            return_code: "0",
            error_description: "",
            SRNum: "2000008106",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const results = await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "Run bulky item analysis",
              responsibleAgencyCode: "76",
            },
          },
        ],
        {
          env: {
            GNP_311_SUBMISSION_ENABLED: "true",
            DYNAMO_TABLE: "table",
            S3_UPLOAD_BUCKET: "bucket",
            SQS_QUEUE_URL: "queue",
            ANALYZER_BASE_URL: "https://analyzer.example.test",
            ANALYZER_API_KEY: "analyzer-key",
            SF311_CREATESR_URL: "https://hub.example.test/createsr",
            SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
            SF311_BASIC_AUTH_USER: "user",
            SF311_BASIC_AUTH_PASS: "pass",
          },
          now,
          tableName: "table",
          siteId: "site-1",
          task: {
            taskId: "task-1",
            checkId: "check-1",
            description: "A mattress has been left on the sidewalk.",
            sourceArtifactIds: ["artifact-1"],
            location: { latitude: 37.77, longitude: -122.42 },
          },
        },
      );

      expect(classifyEvidence).toHaveBeenCalledWith({
        classifierId: "bulky-items",
        evidence: {
          type: "text",
          text: "A mattress has been left on the sidewalk.",
        },
        requestId: "task-1",
        appId: "good-neighbor-app",
      });
      expect(results).toMatchObject([
        {
          code: "create_311_ticket",
          status: "submitted",
          payload: {
            tickets: [
              {
                serviceCode: "1.1.4.7.10.0",
                srNum: "2000008106",
                attachments: [],
              },
            ],
          },
        },
      ]);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
        NatureofRequest: "1.1.4.7.10.0",
        ProblemDescription: "A mattress has been left on the sidewalk.",
      });
    } finally {
      createAnalyzerClient.mockReset();
      getAnalyzerApiKey.mockReset();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("checkpoints created SF311 tickets when classifier fan-out later fails", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      })
      .mockResolvedValueOnce({});
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("image"),
      contentType: "image/jpeg",
    });
    getAnalyzerApiKey.mockResolvedValueOnce("analyzer-key");
    createAnalyzerClient.mockReturnValueOnce({
      classifyEvidence: vi.fn().mockResolvedValueOnce({
        labels: ["Mattress", "Furniture"],
      }),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              return_code: "0",
              error_description: "",
              SRNum: "2000008106",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              return_code: "4001",
              return_message: "NatureofRequest is invalid",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const results = await executeAppActions(
        [
          {
            code: "create_311_ticket",
            payload: {
              serviceCodeOrAction: "Run bulky item analysis",
              responsibleAgencyCode: "76",
            },
          },
        ],
        {
          env: {
            GNP_311_SUBMISSION_ENABLED: "true",
            DYNAMO_TABLE: "table",
            S3_UPLOAD_BUCKET: "bucket",
            SQS_QUEUE_URL: "queue",
            ANALYZER_BASE_URL: "https://analyzer.example.test",
            ANALYZER_API_KEY: "analyzer-key",
            SF311_CREATESR_URL: "https://hub.example.test/createsr",
            SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
            SF311_BASIC_AUTH_USER: "user",
            SF311_BASIC_AUTH_PASS: "pass",
          },
          now,
          tableName: "table",
          siteId: "site-1",
          trigger: "user_confirmed",
          task: {
            taskId: "task-1",
            checkId: "check-1",
            description: "Bulky items",
            sourceArtifactIds: ["artifact-1"],
          },
        },
      );

      expect(results).toMatchObject([
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "4001",
          payload: {
            tickets: [
              {
                serviceCode: "1.1.4.7.10.0",
                responsibleAgency: "76",
                sourceRequestId: "task-1-1147100",
                srNum: "2000008106",
                attachments: [],
              },
            ],
          },
          externalId: "2000008106",
        },
      ]);
      const checkpoint = send.mock.calls[3][0];
      expect(checkpoint).toBeInstanceOf(UpdateCommand);
      expect(
        checkpoint.input.ExpressionAttributeValues[":results"],
      ).toMatchObject([
        {
          status: "failed",
          reason: "fanout_incomplete",
          externalId: "2000008106",
        },
      ]);
      expect(JSON.parse(fetchImpl.mock.calls[1][1].body).NatureofRequest).toBe(
        "1.1.4.7.7.0",
      );
    } finally {
      createAnalyzerClient.mockReset();
      getAnalyzerApiKey.mockReset();
      getObjectBytes.mockReset();
      create311MediaLink.mockReset();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("attaches source images to submitted SF311 service requests", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      });
    create311MediaLink.mockResolvedValueOnce(
      "https://uploads.example.test/image.jpg?X-Amz-Signature=secret",
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              return_code: "0",
              error_description: "",
              SRNum: "2000008106",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            UpdateID: 1234,
            error_description: "",
            return_code: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);
    try {
      expect(
        await executeAppActions(
          [
            {
              code: "create_311_ticket",
              payload: {
                serviceCodeOrAction: "1.1.4.7.20.0",
                responsibleAgencyCode: "76",
              },
            },
          ],
          {
            env: {
              GNP_311_SUBMISSION_ENABLED: "true",
              DYNAMO_TABLE: "table",
              S3_UPLOAD_BUCKET: "bucket",
              SQS_QUEUE_URL: "queue",
              SF311_CREATESR_URL: "https://hub.example.test/createsr",
              SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
              SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
              SF311_BASIC_AUTH_USER: "user",
              SF311_BASIC_AUTH_PASS: "pass",
            },
            now,
            tableName: "table",
            siteId: "site-1",
            task: {
              taskId: "task-1",
              checkId: "check-1",
              description: "Trash",
              sourceArtifactIds: ["artifact-1"],
            },
          },
        ),
      ).toEqual([
        {
          code: "create_311_ticket",
          status: "submitted",
          payload: {
            serviceCodeOrAction: "1.1.4.7.20.0",
            responsibleAgencyCode: "76",
            tickets: [
              {
                serviceCode: "1.1.4.7.20.0",
                responsibleAgency: "76",
                sourceRequestId: "task-1-1147200",
                srNum: "2000008106",
                attachments: [
                  {
                    artifactId: "artifact-1",
                    s3Key: "checks/site-1/check-1/North/artifact-1",
                    status: "submitted",
                    updateId: "1234",
                  },
                ],
              },
            ],
          },
          externalId: "2000008106",
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]);
      expect(create311MediaLink).toHaveBeenCalledWith({
        config: expect.objectContaining({ uploadBucket: "bucket" }),
        key: "checks/site-1/check-1/North/artifact-1",
      });
      expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
        SRnum: "2000008106",
        UpdateType: "8",
        SendingAgency: "76",
        SourceOperator: "Good Neighbor App",
        NumericSubType: "1",
        TextSubType:
          "https://uploads.example.test/image.jpg?X-Amz-Signature=secret",
        EffectiveDate: "2026-08-18 12:00:00",
        ToAgencyDate: "",
        Notes: "",
      });
    } finally {
      send.mockReset();
      getObjectBytes.mockReset();
      create311MediaLink.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("keeps created SF311 tickets retryable when image attachment fails", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      });
    create311MediaLink.mockResolvedValueOnce(
      "https://uploads.example.test/image.jpg?X-Amz-Signature=secret",
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              return_code: "0",
              error_description: "",
              SRNum: "2000008106",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              return_code: "5001",
              return_message: "Attachment rejected",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      expect(
        await executeAppActions(
          [
            {
              code: "create_311_ticket",
              payload: {
                serviceCodeOrAction: "1.1.4.7.20.0",
                responsibleAgencyCode: "76",
              },
            },
          ],
          {
            env: {
              GNP_311_SUBMISSION_ENABLED: "true",
              DYNAMO_TABLE: "table",
              S3_UPLOAD_BUCKET: "bucket",
              SQS_QUEUE_URL: "queue",
              SF311_CREATESR_URL: "https://hub.example.test/createsr",
              SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
              SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
              SF311_BASIC_AUTH_USER: "user",
              SF311_BASIC_AUTH_PASS: "pass",
            },
            now,
            tableName: "table",
            siteId: "site-1",
            task: {
              taskId: "task-1",
              checkId: "check-1",
              description: "Trash",
              sourceArtifactIds: ["artifact-1"],
            },
          },
        ),
      ).toMatchObject([
        {
          code: "create_311_ticket",
          status: "failed",
          reason: "attachment_submission_failed",
          payload: {
            tickets: [
              {
                serviceCode: "1.1.4.7.20.0",
                responsibleAgency: "76",
                sourceRequestId: "task-1-1147200",
                srNum: "2000008106",
                attachments: [
                  {
                    artifactId: "artifact-1",
                    s3Key: "checks/site-1/check-1/North/artifact-1",
                    status: "failed",
                    reason: "5001",
                  },
                ],
              },
            ],
          },
          externalId: "2000008106",
        },
      ]);
    } finally {
      send.mockReset();
      getObjectBytes.mockReset();
      create311MediaLink.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it.each(/** @type {const} */ (["task_created", "user_confirmed"]))(
    "redacts bearer links from failed attachment diagnostics for %s",
    async (trigger) => {
      const token = "a".repeat(64);
      const url = `https://media.example/v1/311-media?token=${token}`;
      send
        .mockResolvedValueOnce({
          Items: [
            {
              artifactId: "artifact-1",
              s3Key: "checks/site-1/check-1/image",
              contentType: "image/jpeg",
            },
          ],
        })
        .mockResolvedValueOnce({
          Item: { location: { latitude: 37.7, longitude: -122.4 } },
        })
        .mockResolvedValue({});
      create311MediaLink.mockResolvedValueOnce(url);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ data: { return_code: "0", SRNum: "2000008106" } }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                return_code: "5001",
                echo: `Rejected ${url} please retry`,
                [url]: "echoed as a key",
                encoded: encodeURIComponent(url).replace("token", "%74oken"),
                html: `https://media.example/v1/311-media?other=1&amp;token=${token}`,
                nested: [{ message: JSON.stringify({ TextSubType: url }) }],
                signed: `https://uploads.example/image?X-Amz-Signature=${token}&X-Amz-Credential=${token}`,
              },
            }),
            { status: 500 },
          ),
        );
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const result = await executeAppActions(
          [
            {
              code: "create_311_ticket",
              payload: {
                serviceCodeOrAction: "1.1.4.7.20.0",
                responsibleAgencyCode: "76",
                executionTrigger: trigger,
              },
            },
          ],
          {
            env: {
              GNP_311_SUBMISSION_ENABLED: "true",
              DYNAMO_TABLE: "table",
              S3_UPLOAD_BUCKET: "bucket",
              SQS_QUEUE_URL: "queue",
              SF311_CREATESR_URL: "https://hub.example/createsr",
              SF311_UPDATESR_URL: "https://hub.example/updatesr",
              SF311_BASIC_AUTH_USER: "user",
              SF311_BASIC_AUTH_PASS: "pass",
            },
            now,
            tableName: "table",
            siteId: "site-1",
            taskId: "task-1",
            trigger,
            task: {
              taskId: "task-1",
              checkId: "check-1",
              description: "Trash",
              sourceArtifactIds: ["artifact-1"],
            },
          },
        );
        // The actual outbound request must keep its usable bearer URL.
        expect(JSON.parse(fetchImpl.mock.calls[1][1].body).TextSubType).toBe(
          url,
        );
        const attachment = /** @type {any} */ (result[0]).payload.tickets[0]
          .attachments[0];
        expect(attachment.status).toBe("failed");
        expect(attachment.diagnostics.request.TextSubType).toContain(
          "token=[redacted]",
        );
        expect(JSON.stringify(result)).not.toContain(token);
        if (trigger === "user_confirmed") {
          const checkpoint = send.mock.calls.find(
            ([command]) => command instanceof UpdateCommand,
          );
          expect(checkpoint).toBeDefined();
          if (!checkpoint) throw new Error("Missing checkpoint");
          expect(
            JSON.stringify(
              checkpoint[0].input.ExpressionAttributeValues[":results"],
            ),
          ).not.toContain(token);
        }
      } finally {
        send.mockReset();
        create311MediaLink.mockReset();
        vi.unstubAllGlobals();
      }
    },
  );

  it("retries failed image attachments without recreating the SF311 ticket", async () => {
    send
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      })
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      });
    create311MediaLink.mockResolvedValueOnce(
      "https://uploads.example.test/image.jpg?X-Amz-Signature=secret",
    );
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          UpdateID: 1234,
          error_description: "",
          return_code: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    try {
      expect(
        await executeAppActions(
          [
            {
              code: "create_311_ticket",
              payload: {
                serviceCodeOrAction: "1.1.4.7.20.0",
                responsibleAgencyCode: "76",
              },
            },
          ],
          {
            env: {
              GNP_311_SUBMISSION_ENABLED: "true",
              DYNAMO_TABLE: "table",
              S3_UPLOAD_BUCKET: "bucket",
              SQS_QUEUE_URL: "queue",
              SF311_CREATESR_URL: "https://hub.example.test/createsr",
              SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
              SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
              SF311_BASIC_AUTH_USER: "user",
              SF311_BASIC_AUTH_PASS: "pass",
            },
            now,
            tableName: "table",
            siteId: "site-1",
            task: {
              taskId: "task-1",
              checkId: "check-1",
              description: "Trash",
              sourceArtifactIds: ["artifact-1"],
            },
            priorResults: [
              {
                code: "create_311_ticket",
                status: "failed",
                reason: "attachment_submission_failed",
                payload: {
                  tickets: [
                    {
                      serviceCode: "1.1.4.7.20.0",
                      responsibleAgency: "76",
                      sourceRequestId: "task-1-1147200",
                      srNum: "2000008106",
                      attachments: [
                        {
                          artifactId: "artifact-1",
                          s3Key: "checks/site-1/check-1/North/artifact-1",
                          status: "failed",
                          reason: "5001",
                        },
                      ],
                    },
                  ],
                },
                externalId: "2000008106",
                recordedAt: "2026-08-18T11:59:00.000Z",
              },
            ],
          },
        ),
      ).toMatchObject([
        {
          code: "create_311_ticket",
          status: "submitted",
          payload: {
            tickets: [
              {
                serviceCode: "1.1.4.7.20.0",
                srNum: "2000008106",
                attachments: [
                  {
                    artifactId: "artifact-1",
                    s3Key: "checks/site-1/check-1/North/artifact-1",
                    status: "submitted",
                    updateId: "1234",
                  },
                ],
              },
            ],
          },
          externalId: "2000008106",
        },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
        SRnum: "2000008106",
        UpdateType: "8",
      });
    } finally {
      send.mockReset();
      getObjectBytes.mockReset();
      create311MediaLink.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("leaves email and form integrations unconfigured", async () => {
    const results = await executeAppActions(
      [{ code: "compose_email" }, { code: "create_fire_hazard_report" }],
      { now },
    );
    expect(results).toMatchObject([
      { code: "compose_email", status: "not_configured" },
      { code: "create_fire_hazard_report", status: "not_configured" },
    ]);
    expect(summarizeAppActionResults(results)).toBe("not_configured");
  });

  it("summarizes initial and completed app action state", () => {
    expect(initialAppActionStatus([])).toBe("none");
    expect(initialAppActionStatus([{ code: "open_phone" }])).toBe("pending");
    expect(summarizeAppActionResults([])).toBe("none");
    expect(
      summarizeAppActionResults([
        {
          code: "open_phone",
          status: "recorded",
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]),
    ).toBe("recorded");
  });
});

describe("311 ticket closure", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");
  const ENV = {
    GNP_311_SUBMISSION_ENABLED: "true",
    DYNAMO_TABLE: "table",
    S3_UPLOAD_BUCKET: "bucket",
    SQS_QUEUE_URL: "queue",
    SF311_CREATESR_URL: "https://hub.example.test/createsr",
    SF311_UPDATESR_URL: "https://hub.example.test/updatesr",
    SF311_AGENCY_LOOKUP_URL: "https://hub.example.test/lookup",
    SF311_LATEST_UPDATES_URL: "https://hub.example.test/latest/{agencyID}",
    SF311_BASIC_AUTH_USER: "user",
    SF311_BASIC_AUTH_PASS: "pass",
  };

  afterEach(() => {
    send.mockReset();
    vi.unstubAllGlobals();
  });

  it("eligibleTicketsForClosure only selects agency-76 submitted tickets", () => {
    const results = [
      SUBMITTED_311_RESULT,
      {
        ...SUBMITTED_311_RESULT,
        payload: {
          tickets: [
            {
              serviceCode: "1.23.1.1.1.0",
              responsibleAgency: "16",
              srNum: "2000008107",
              attachments: [],
            },
          ],
        },
      },
      {
        ...SUBMITTED_311_RESULT,
        status: "failed",
        payload: {
          tickets: [
            {
              serviceCode: "1.1.4.7.9.0",
              responsibleAgency: "76",
              srNum: "2000008108",
              attachments: [],
            },
          ],
        },
      },
    ];
    expect(
      eligibleTicketsForClosure(results).get("1.1.4.7.20.0"),
    ).toMatchObject({ ticket: { srNum: "2000008106" } });
    expect(eligibleTicketsForClosure(results).size).toBe(1);
  });

  it("closes eligible agency-76 tickets with UpdateType 11", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          UpdateID: 4321,
          error_description: "",
          return_code: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchImpl);

    const results = await executeAppActions(
      [{ code: "close_311_ticket", payload: {} }],
      { env: ENV, now, priorResults: [SUBMITTED_311_RESULT] },
    );
    expect(results).toEqual([
      {
        code: "close_311_ticket",
        status: "submitted",
        payload: {
          closures: [
            {
              serviceCode: "1.1.4.7.20.0",
              srNum: "2000008106",
              closedReasonCode: "1",
              status: "closed",
              updateId: "4321",
            },
          ],
        },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      SRnum: "2000008106",
      UpdateType: "11",
      SendingAgency: "76",
      SourceOperator: "Good Neighbor App",
      NumericSubType: "1",
      TextSubType: "",
      EffectiveDate: "2026-08-18 12:00:00",
      ToAgencyDate: "",
      Notes: "",
    });
  });

  it.each(["sf311_closure_state_unknown", "sf311_timeout"])(
    "retries a saved %s closure directly without consulting the updates feed",
    async (reason) => {
      const fetchImpl = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchImpl);
      const results = await executeAppActions(
        [{ code: "close_311_ticket", payload: {} }],
        {
          env: ENV,
          now,
          priorResults: [
            SUBMITTED_311_RESULT,
            {
              code: "close_311_ticket",
              status: "failed",
              recordedAt: now.toISOString(),
              payload: {
                closures: [
                  {
                    serviceCode: "1.1.4.7.20.0",
                    srNum: "2000008106",
                    status: "failed",
                    reason,
                  },
                ],
              },
            },
          ],
        },
      );
      expect(results[0]).toMatchObject({
        status: "submitted",
        payload: { closures: [{ srNum: "2000008106", status: "closed" }] },
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1].method).toBe("POST");
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
        SRnum: "2000008106",
        UpdateType: "11",
        SendingAgency: "76",
        NumericSubType: "1",
      });
    },
  );

  it("retries a lost closure response and skips the saved success thereafter", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection lost after request"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const action = [{ code: "close_311_ticket", payload: {} }];
    const first = await executeAppActions(action, {
      env: ENV,
      now,
      priorResults: [SUBMITTED_311_RESULT],
    });
    expect(first[0].status).toBe("failed");
    const second = await executeAppActions(action, {
      env: ENV,
      now,
      priorResults: [SUBMITTED_311_RESULT, ...first],
    });
    expect(second[0].status).toBe("submitted");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toMatchObject({
        UpdateType: "11",
        SRnum: "2000008106",
      });
    }
    await executeAppActions(action, {
      env: ENV,
      now,
      priorResults: [SUBMITTED_311_RESULT, ...second],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps an unconfirmed closure failed until HUB returns success", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4321 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ return_code: 0 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const actions = [{ code: "close_311_ticket", payload: {} }];
    const failed = await executeAppActions(actions, {
      env: ENV,
      now,
      priorResults: [SUBMITTED_311_RESULT],
    });
    expect(failed[0]).toMatchObject({
      status: "failed",
      payload: {
        closures: [{ status: "failed", reason: "missing_return_code" }],
      },
    });
    const retried = await executeAppActions(actions, {
      env: ENV,
      now,
      priorResults: [SUBMITTED_311_RESULT, ...failed],
    });
    expect(retried[0]).toMatchObject({
      status: "submitted",
      payload: { closures: [{ status: "closed" }] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("closes every eligible ticket on classifier fan-out", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4322, return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const fanout = {
      code: "create_311_ticket",
      status: "submitted",
      payload: {
        tickets: [
          {
            serviceCode: "1.1.4.7.10.0",
            responsibleAgency: "76",
            srNum: "2000008106",
            attachments: [],
          },
          {
            serviceCode: "1.1.4.7.7.0",
            responsibleAgency: "76",
            srNum: "2000008107",
            attachments: [],
          },
        ],
      },
      recordedAt: "2026-08-18T11:00:00.000Z",
    };

    const results = await executeAppActions(
      [{ code: "close_311_ticket", payload: {} }],
      { env: ENV, now, priorResults: [fanout] },
    );
    expect(results[0]?.status).toBe("submitted");
    expect(results[0]?.payload?.closures).toEqual([
      {
        serviceCode: "1.1.4.7.10.0",
        srNum: "2000008106",
        closedReasonCode: "1",
        status: "closed",
        updateId: "4321",
      },
      {
        serviceCode: "1.1.4.7.7.0",
        srNum: "2000008107",
        closedReasonCode: "1",
        status: "closed",
        updateId: "4322",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("records partial closure and never blocks submission rollup", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            return_code: 26,
            error_description: "SendingAgency Must Be ResponsibleAgency",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const fanout = {
      code: "create_311_ticket",
      status: "submitted",
      payload: {
        tickets: [
          {
            serviceCode: "1.1.4.7.10.0",
            responsibleAgency: "76",
            srNum: "2000008106",
            attachments: [],
          },
          {
            serviceCode: "1.1.4.7.7.0",
            responsibleAgency: "76",
            srNum: "2000008107",
            attachments: [],
          },
        ],
      },
      recordedAt: "2026-08-18T11:00:00.000Z",
    };

    const results = await executeAppActions(
      [{ code: "close_311_ticket", payload: {} }],
      { env: ENV, now, priorResults: [fanout] },
    );
    expect(results[0]?.status).toBe("partial");
    expect(results[0]?.payload?.closures).toMatchObject([
      { serviceCode: "1.1.4.7.10.0", status: "closed" },
      { serviceCode: "1.1.4.7.7.0", status: "failed", reason: "26" },
    ]);
    // A submitted filing result plus a failed closure still rolls up non-failed.
    expect(summarizeAppActionResults([SUBMITTED_311_RESULT, ...results])).toBe(
      "partial",
    );
  });

  it("skips already-closed tickets and retries failed closures", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ UpdateID: 4323, return_code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const fanout = {
      code: "create_311_ticket",
      status: "submitted",
      payload: {
        tickets: [
          {
            serviceCode: "1.1.4.7.20.0",
            responsibleAgency: "76",
            srNum: "2000008106",
            attachments: [],
          },
          {
            serviceCode: "1.1.4.7.10.0",
            responsibleAgency: "76",
            srNum: "2000008107",
            attachments: [],
          },
        ],
      },
      recordedAt: "2026-08-18T11:00:00.000Z",
    };

    const results = await executeAppActions(
      [{ code: "close_311_ticket", payload: {} }],
      {
        env: ENV,
        now,
        priorResults: [
          fanout,
          {
            code: "close_311_ticket",
            status: "partial",
            payload: {
              closures: [
                {
                  serviceCode: "1.1.4.7.20.0",
                  srNum: "2000008106",
                  status: "closed",
                  updateId: "4321",
                },
                {
                  serviceCode: "1.1.4.7.10.0",
                  srNum: "2000008107",
                  status: "failed",
                  reason: "sf311_timeout",
                },
              ],
            },
            recordedAt: "2026-08-18T11:30:00.000Z",
          },
        ],
      },
    );
    // 1.1.4.7.20.0 was already closed: skipped without a second UpdateSR.
    // 1.1.4.7.10.0 was filed under 76 and closed previously as failed: retried.
    expect(results).toEqual([
      {
        code: "close_311_ticket",
        status: "submitted",
        payload: {
          closures: [
            {
              serviceCode: "1.1.4.7.20.0",
              srNum: "2000008106",
              status: "closed",
              updateId: "4321",
            },
            {
              serviceCode: "1.1.4.7.10.0",
              srNum: "2000008107",
              closedReasonCode: "1",
              status: "closed",
              updateId: "4323",
            },
          ],
        },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).SRnum).toBe(
      "2000008107",
    );
  });

  it("checkpoints each closed ticket so lease recovery never re-closes an SR", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ UpdateID: 4322, return_code: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const fanout = {
      code: "create_311_ticket",
      status: "submitted",
      payload: {
        tickets: [
          {
            serviceCode: "1.1.4.7.20.0",
            responsibleAgency: "76",
            srNum: "2000008106",
            attachments: [],
          },
          {
            serviceCode: "1.1.4.7.10.0",
            responsibleAgency: "76",
            srNum: "2000008107",
            attachments: [],
          },
        ],
      },
      recordedAt: "2026-08-18T11:00:00.000Z",
    };

    await executeAppActions([{ code: "close_311_ticket", payload: {} }], {
      env: ENV,
      now,
      tableName: "table",
      siteId: "site-1",
      taskId: "task-1",
      executionLease: {
        status: "resolving",
        attribute: "resolutionLeaseExpiresAt",
        value: "2026-08-18T12:05:00.000Z",
      },
      priorResults: [fanout],
    });

    // One checkpoint per successful UpdateSR, each pinned to the resolution
    // lease so a reclaimed executor cannot persist stale closures.
    expect(send).toHaveBeenCalledTimes(2);
    for (const [index] of ["2000008106", "2000008107"].entries()) {
      const checkpoint = send.mock.calls[index][0];
      expect(checkpoint).toBeInstanceOf(UpdateCommand);
      expect(checkpoint.input.Key).toEqual({
        pk: "SITE#site-1",
        sk: "TASK#task-1",
      });
      expect(checkpoint.input.ConditionExpression).toBe(
        "#status = :executionStatus AND #lease = :leaseExpiresAt",
      );
      expect(checkpoint.input.ExpressionAttributeNames["#lease"]).toBe(
        "resolutionLeaseExpiresAt",
      );
      expect(
        checkpoint.input.ExpressionAttributeValues[":executionStatus"],
      ).toBe("resolving");
      expect(
        checkpoint.input.ExpressionAttributeValues[":leaseExpiresAt"],
      ).toBe("2026-08-18T12:05:00.000Z");
      // The write merges with the persisted prior results: the create result
      // survives alongside the closure, so lease recovery still sees the
      // `closed` record AND keeps closure eligibility intact.
      expect(
        checkpoint.input.ExpressionAttributeValues[":results"],
      ).toMatchObject([
        { code: "create_311_ticket", status: "submitted" },
        {
          code: "close_311_ticket",
          status: "submitted",
          payload: {
            closures: [
              { srNum: "2000008106", status: "closed" },
              ...(index === 1
                ? [{ srNum: "2000008107", status: "closed" }]
                : []),
            ],
          },
        },
      ]);
      expect(
        checkpoint.input.ExpressionAttributeValues[":results"],
      ).toHaveLength(2);
    }
  });

  it("stops closing remaining tickets when the completion lease is lost mid-loop", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ UpdateID: 4321, return_code: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    // The first checkpoint fails: the lease was reclaimed by another executor
    // (ConditionalCheckFailedException shape is irrelevant — any send failure
    // means the persisted prior results no longer include this closure).
    send.mockRejectedValueOnce(new Error("The conditional request failed"));
    const fanout = {
      code: "create_311_ticket",
      status: "submitted",
      payload: {
        tickets: [
          {
            serviceCode: "1.1.4.7.20.0",
            responsibleAgency: "76",
            srNum: "2000008106",
            attachments: [],
          },
          {
            serviceCode: "1.1.4.7.10.0",
            responsibleAgency: "76",
            srNum: "2000008107",
            attachments: [],
          },
        ],
      },
      recordedAt: "2026-08-18T11:00:00.000Z",
    };

    const results = await executeAppActions(
      [{ code: "close_311_ticket", payload: {} }],
      {
        env: ENV,
        now,
        tableName: "table",
        siteId: "site-1",
        taskId: "task-1",
        completionLeaseExpiresAt: "2026-08-18T12:05:00.000Z",
        priorResults: [fanout],
      },
    );

    // The second SR was never sent to HUB: without a durable closed record,
    // issuing that update would risk a double close after lease recovery.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The attempted ticket did close at HUB, but the unattempted ticket keeps
    // the result partial so the owning resolution cannot become terminal.
    expect(results).toEqual([
      {
        code: "close_311_ticket",
        status: "partial",
        payload: {
          closures: [
            {
              serviceCode: "1.1.4.7.20.0",
              srNum: "2000008106",
              closedReasonCode: "1",
              status: "closed",
              updateId: "4321",
            },
          ],
        },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
  });

  it("records no closure result when no eligible tickets exist", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const cityManaged = {
      code: "create_311_ticket",
      status: "submitted",
      payload: {
        tickets: [
          {
            serviceCode: "1.23.1.1.1.0",
            responsibleAgency: "16",
            srNum: "2000008109",
            attachments: [],
          },
        ],
      },
      recordedAt: "2026-08-18T11:00:00.000Z",
    };

    const results = await executeAppActions(
      [{ code: "close_311_ticket", payload: {} }],
      { env: ENV, now, priorResults: [cityManaged] },
    );
    expect(results).toEqual([
      {
        code: "close_311_ticket",
        status: "recorded",
        payload: { closures: [] },
        recordedAt: "2026-08-18T12:00:00.000Z",
      },
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it("files a separate deliberate ticket after silent filing and preserves both through checkpoint merges", async () => {
  const silent = {
    ...SUBMITTED_311_RESULT,
    payload: {
      ...SUBMITTED_311_RESULT.payload,
      executionTrigger: "task_created",
      responsibleAgencyCode: "76",
    },
  };
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: { return_code: "0", SRNum: "2000009999" } }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchImpl);
  const results = await executeAppActions(
    [
      {
        code: "create_311_ticket",
        payload: {
          executionTrigger: "user_confirmed",
          serviceCodeOrAction: "1.1.4.7.20.0",
          responsibleAgencyCode: "99",
        },
      },
    ],
    {
      env: {
        GNP_311_SUBMISSION_ENABLED: "true",
        DYNAMO_TABLE: "table",
        S3_UPLOAD_BUCKET: "bucket",
        SQS_QUEUE_URL: "queue",
        SF311_CREATESR_URL: "https://hub.example/createsr",
        SF311_BASIC_AUTH_USER: "user",
        SF311_BASIC_AUTH_PASS: "pass",
      },
      tableName: "table",
      siteId: "site",
      trigger: "user_confirmed",
      task: {
        taskId: "task-1",
        location: { latitude: 37.7, longitude: -122.4 },
      },
      priorResults: [silent],
      onCheckpoint: async () => {},
    },
  );
  expect(results[0].status).toBe("submitted");
  expect(fetchImpl).toHaveBeenCalledOnce();
  const merged = mergeAppActionResults([silent], results[0]);
  expect(merged).toHaveLength(2);
  expect(merged[0]).toMatchObject({
    payload: {
      tickets: [
        { srNum: "2000009999", sourceRequestId: expect.stringMatching(/^u-/) },
      ],
    },
  });
  expect(merged[1]).toEqual(silent);
  expect(mergeAppActionResults(merged, results[0])).toEqual(merged);
});
