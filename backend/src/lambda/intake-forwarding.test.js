import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class {
    send = send;
  },
  GetSecretValueCommand: class {
    /** @param {unknown} input */
    constructor(input) {
      this.input = input;
    }
  },
}));

import { handler } from "./intake.js";
import { resetPosthogApiKeyCache } from "../handlers/posthog-api-key.js";

const cases = [
  {
    route: "POST /v1/client-errors",
    body: { type: "Error", message: "test failure", id: "test-client" },
    event: "$exception",
  },
  {
    route: "POST /v1/client-events",
    body: {
      event: "camera_opened",
      id: "test-client",
      properties: { flow: "perimeter" },
    },
    event: "camera_opened",
  },
  {
    route: "POST /v1/feedback",
    body: { message: "test feedback", id: "test-client" },
    event: "survey sent",
  },
];

/**
 * @param {typeof cases[number]} sample
 * @returns {Promise<import("aws-lambda").APIGatewayProxyResultV2 | void>}
 */
async function invoke(sample) {
  return handler(
    /** @type {import("aws-lambda").APIGatewayProxyEventV2} */ (
      /** @type {unknown} */ ({
        routeKey: sample.route,
        headers: {},
        body: JSON.stringify(sample.body),
        requestContext: { requestId: "test-request" },
      })
    ),
    /** @type {import("aws-lambda").Context} */ ({}),
    () => {},
  );
}

describe("intake forwarding with its deployed environment", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    // Match the isolated intake Lambda: no main API infrastructure settings.
    for (const key of [
      "S3_UPLOAD_BUCKET",
      "SQS_QUEUE_URL",
      "DYNAMO_TABLE",
      "POSTHOG_PROJECT_API_KEY",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("POSTHOG_API_KEY_SECRET_ARN", "arn:test:posthog");
    vi.stubEnv("POSTHOG_HOST", "https://posthog.example");
    vi.stubEnv("FEEDBACK_SURVEY_ID", "test-survey");
    vi.stubEnv("FEEDBACK_QUESTION_ID", "test-question");
    send.mockResolvedValue({ SecretString: "test-ingest-key" });
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    resetPosthogApiKeyCache();
    send.mockReset();
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(cases)(
    "forwards $route through the real handler and secret resolver",
    async (sample) => {
      expect(await invoke(sample)).toEqual({ statusCode: 204 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].input).toEqual({
        SecretId: "arn:test:posthog",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe("https://posthog.example/batch/");
      const payload = JSON.parse(init.body);
      expect(payload.api_key).toBe("test-ingest-key");
      expect(payload.batch[0].event).toBe(sample.event);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "keeps $route log-only when no key is configured",
    async (sample) => {
      vi.stubEnv("POSTHOG_API_KEY_SECRET_ARN", undefined);
      expect(await invoke(sample)).toEqual({ statusCode: 204 });
      expect(send).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it.each(cases)(
    "keeps $route best-effort when secret retrieval fails",
    async (sample) => {
      send.mockRejectedValue(new Error("test secret failure"));
      expect(await invoke(sample)).toEqual({ statusCode: 204 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    },
  );
});
