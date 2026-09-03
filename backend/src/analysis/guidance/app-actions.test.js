import { describe, expect, it, vi } from "vitest";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

const {
  createAnalyzerClient,
  getAnalyzerApiKey,
  getObjectBytes,
  presignGet,
  send,
} = vi.hoisted(() => ({
  createAnalyzerClient: vi.fn(),
  getAnalyzerApiKey: vi.fn(),
  getObjectBytes: vi.fn(),
  presignGet: vi.fn(),
  send: vi.fn(),
}));
vi.mock("../../db.js", () => ({ ddb: { send } }));
vi.mock("../../s3.js", () => ({ getObjectBytes, presignGet }));
vi.mock("../api-key.js", () => ({ getAnalyzerApiKey }));
vi.mock("../analyzer-client.js", () => ({ createAnalyzerClient }));

import {
  executeAppActions,
  initialAppActionStatus,
  is311SubmissionEnabled,
  summarizeAppActionResults,
} from "./app-actions.js";

describe("app action execution", () => {
  const now = new Date("2026-08-18T12:00:00.000Z");

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
      presignGet.mockReset();
      vi.unstubAllGlobals();
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
    getAnalyzerApiKey.mockResolvedValueOnce("analyzer-key");
    createAnalyzerClient.mockReturnValueOnce({
      classifyImage: vi.fn().mockResolvedValueOnce({ labels: [] }),
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
          reason: "no_service_codes",
          payload: { serviceCodeOrAction: "Run graffiti analysis" },
          recordedAt: "2026-08-18T12:00:00.000Z",
        },
      ]);
    } finally {
      createAnalyzerClient.mockReset();
      getAnalyzerApiKey.mockReset();
      getObjectBytes.mockReset();
      send.mockReset();
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
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});
    getObjectBytes.mockResolvedValueOnce({
      bytes: Buffer.from("image"),
      contentType: "image/jpeg",
    });
    getAnalyzerApiKey.mockResolvedValueOnce("analyzer-key");
    createAnalyzerClient.mockReturnValueOnce({
      classifyImage: vi.fn().mockResolvedValueOnce({
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
      presignGet.mockReset();
      send.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("attaches source images to submitted SF311 service requests", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      });
    presignGet.mockResolvedValueOnce(
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
      expect(presignGet).toHaveBeenCalledWith({
        bucket: "bucket",
        key: "checks/site-1/check-1/North/artifact-1",
        expiresIn: 300,
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
      presignGet.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("keeps created SF311 tickets retryable when image attachment fails", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      });
    presignGet.mockResolvedValueOnce(
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
      presignGet.mockReset();
      vi.unstubAllGlobals();
    }
  });

  it("retries failed image attachments without recreating the SF311 ticket", async () => {
    send
      .mockResolvedValueOnce({
        Item: {
          location: {
            latitude: 37.76656393517443,
            longitude: -122.4213267021692,
          },
        },
      })
      .mockResolvedValueOnce({
        Items: [
          {
            artifactId: "artifact-1",
            s3Key: "checks/site-1/check-1/North/artifact-1",
            contentType: "image/jpeg",
          },
        ],
      });
    presignGet.mockResolvedValueOnce(
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
      presignGet.mockReset();
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
