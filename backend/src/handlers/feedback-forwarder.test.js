import { afterEach, describe, expect, it, vi } from "vitest";

const getPosthogApiKey = vi.fn();
vi.mock("./posthog-api-key.js", () => ({
  /**
   * @param {...unknown} args
   * @returns {unknown} passthrough to the mock fn
   */
  getPosthogApiKey: (...args) => getPosthogApiKey(...args),
}));

const { forwardFeedback, toIso, FORWARD_FAILED_MARKER } = await import(
  "./feedback-forwarder.js"
);

/**
 * Build a scrubbed feedback shape for forwarder input.
 * @param {Partial<import("./scrub-feedback.js").ScrubbedFeedback>} [over]
 * @returns {import("./scrub-feedback.js").ScrubbedFeedback}
 */
function feedback(over = {}) {
  return {
    text: "The camera is great but uploads are slow",
    page: "/today",
    site: "M0101",
    release: "abc123",
    id: "uuid-1",
    ts: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

/** Config with survey IDs set (the configured-for-egress state). */
const config = {
  uploadBucket: "b",
  queueUrl: "q",
  dynamoTable: "t",
  posthogFeedbackSurveyId: "survey-uuid",
  posthogFeedbackQuestionId: "question-uuid",
};

/** Config without survey IDs (the pre-config / kill-switch state). */
const configNoSurvey = { uploadBucket: "b", queueUrl: "q", dynamoTable: "t" };

describe("forwardFeedback", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    getPosthogApiKey.mockReset();
    vi.restoreAllMocks();
  });

  it("log-only when survey IDs are unset (even with a key available)", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn();

    const outcome = await forwardFeedback(
      feedback(),
      { userAgent: "UA" },
      { fetchImpl, config: configNoSurvey },
    );

    expect(outcome).toBe("log-only");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getPosthogApiKey).not.toHaveBeenCalled();
    const line = /** @type {string} */ (log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      marker: "FeedbackLogOnly",
      textLength: 40,
    });
  });

  it("log-only when no key is resolvable (survey IDs set)", async () => {
    getPosthogApiKey.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn();

    const outcome = await forwardFeedback(
      feedback(),
      { userAgent: "UA" },
      { fetchImpl, config },
    );

    expect(outcome).toBe("log-only");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards a mapped `survey sent` batch event", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    const outcome = await forwardFeedback(
      feedback(),
      { userAgent: "UA/1" },
      {
        fetchImpl,
        host: "https://ph.example",
        now: () => 1700000000000,
        config,
      },
    );

    expect(outcome).toBe("forwarded");
    const [url, init] = /** @type {[string, { body: string }]} */ (
      fetchImpl.mock.calls[0]
    );
    expect(url).toBe("https://ph.example/batch/");
    const body = JSON.parse(/** @type {string} */ (init.body));
    expect(body.api_key).toBe("phc_test");
    expect(body.batch).toHaveLength(1);
    expect(body.sentAt).toBeTypeOf("string");
    const [evt] = body.batch;
    expect(evt).toMatchObject({
      event: "survey sent",
      distinct_id: "uuid-1",
      timestamp: "2026-09-01T10:00:00.000Z",
      properties: {
        $survey_id: "survey-uuid",
        "$survey_response_question-uuid": feedback().text,
        app_source: "/today",
        site: "M0101",
        release: "abc123",
        user_agent: "UA/1",
        $process_person_profile: false,
      },
    });
  });

  it("omits optional properties when absent (no undefined noise)", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await forwardFeedback(
      feedback({ page: undefined, site: undefined, release: undefined }),
      {},
      { fetchImpl, config },
    );

    const [, init] = /** @type {[string, { body: string }]} */ (
      fetchImpl.mock.calls[0]
    );
    const [evt] = JSON.parse(/** @type {string} */ (init.body)).batch;
    for (const key of ["app_source", "site", "release", "user_agent"]) {
      expect(key in evt.properties).toBe(false);
    }
  });

  it("non-2xx ingest response → FeedbackForwardFailed + 'failed'", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const outcome = await forwardFeedback(feedback(), {}, { fetchImpl, config });

    expect(outcome).toBe("failed");
    const line = /** @type {string} */ (warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "warn",
      marker: FORWARD_FAILED_MARKER,
      reason: "forward_failed",
    });
  });

  it("fetch failure → FeedbackForwardFailed + 'failed' (never throws)", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("down"));

    const outcome = await forwardFeedback(feedback(), {}, { fetchImpl, config });

    expect(outcome).toBe("failed");
    const line = /** @type {string} */ (warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      marker: FORWARD_FAILED_MARKER,
      reason: "forward_failed",
    });
  });

  it("secret fetch failure → FeedbackForwardFailed + 'failed'", async () => {
    getPosthogApiKey.mockRejectedValue(new Error("kms"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const outcome = await forwardFeedback(feedback(), {}, { config });

    expect(outcome).toBe("failed");
    const line = /** @type {string} */ (warn.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      marker: FORWARD_FAILED_MARKER,
      reason: "secret_fetch_failed",
    });
  });

  it("toIso passes parseable timestamps and drops garbage", () => {
    expect(toIso("2026-09-01T10:00:00.000Z")).toBe(
      "2026-09-01T10:00:00.000Z",
    );
    expect(toIso("not-a-date")).toBeUndefined();
    expect(toIso(undefined)).toBeUndefined();
  });
});