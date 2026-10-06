import { afterEach, describe, expect, it, vi } from "vitest";

const getPosthogApiKey = vi.fn();
vi.mock("./posthog-api-key.js", () => ({
  /**
   * @param {...unknown} args
   * @returns {unknown}
   */
  getPosthogApiKey: (...args) => getPosthogApiKey(...args),
}));

const {
  forwardClientEvent,
  toPosthogEvent,
  userAgentProperties,
  FORWARD_FAILED_MARKER,
  FORWARD_OK_MARKER,
  LOG_ONLY_MARKER,
} = await import("./event-forwarder.js");

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 8.0.0; SM-G930F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.181 Mobile Safari/537.36";

/**
 * @param {Partial<import("./scrub-client-event.js").ScrubbedClientEvent>} [over]
 * @returns {import("./scrub-client-event.js").ScrubbedClientEvent}
 */
function report(over = {}) {
  return {
    event: "$pageview",
    id: "uuid-1",
    ts: "2026-10-06T10:00:00.000Z",
    release: "abc",
    properties: { $pathname: "/check", $screen_width: 412 },
    ...over,
  };
}

const config = { uploadBucket: "b", queueUrl: "q", dynamoTable: "t" };

/**
 * Minimal fetch Response stand-in.
 * @param {boolean} ok
 * @param {number} status
 * @returns {Response}
 */
function response(ok, status) {
  return /** @type {Response} */ ({ ok, status });
}

describe("toPosthogEvent", () => {
  it("merges client properties, UA-derived properties, and release", () => {
    const event = toPosthogEvent(report(), { userAgent: ANDROID_UA });
    expect(event).toEqual({
      event: "$pageview",
      distinct_id: "uuid-1",
      timestamp: "2026-10-06T10:00:00.000Z",
      properties: {
        $pathname: "/check",
        $screen_width: 412,
        $browser: "Chrome",
        $browser_version: "88.0.4324.181",
        $os: "Android",
        $os_version: "8.0.0",
        $device_type: "Mobile",
        $raw_user_agent: ANDROID_UA,
        release: "abc",
        $lib: "gnp-client-events",
        $process_person_profile: false,
      },
    });
  });

  it("omits UA properties and timestamp when absent", () => {
    const event = toPosthogEvent(
      report({ ts: undefined, release: undefined }),
      {},
    );
    expect(event).not.toHaveProperty("timestamp");
    expect(event.properties).not.toHaveProperty("$browser");
    expect(event.properties).not.toHaveProperty("release");
  });

  it("flags Android WebViews", () => {
    const props = userAgentProperties(
      "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36",
    );
    expect(props.$browser).toBe("Android WebView");
    expect(props.android_webview).toBe(true);
  });
});

describe("forwardClientEvent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    getPosthogApiKey.mockReset();
    vi.restoreAllMocks();
  });

  it("log-only mode logs the event WITH its device properties and never fetches", async () => {
    getPosthogApiKey.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn();

    const outcome = await forwardClientEvent(
      report(),
      { userAgent: ANDROID_UA },
      { fetchImpl, config },
    );

    expect(outcome).toBe("log-only");
    expect(fetchImpl).not.toHaveBeenCalled();
    const line = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(line.marker).toBe(LOG_ONLY_MARKER);
    expect(line.event).toBe("$pageview");
    expect(line.properties.$os_version).toBe("8.0.0");
    expect(line.properties.$pathname).toBe("/check");
  });

  it("posts a batch to /batch/ and logs the OK marker", async () => {
    getPosthogApiKey.mockResolvedValue("phc_key");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(response(true, 200));

    const outcome = await forwardClientEvent(
      report(),
      { userAgent: ANDROID_UA },
      { fetchImpl, config, host: "https://ph.example", now: () => 0 },
    );

    expect(outcome).toBe("forwarded");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://ph.example/batch/");
    const body = JSON.parse(init.body);
    expect(body.api_key).toBe("phc_key");
    expect(body.sent_at).toBe("1970-01-01T00:00:00.000Z");
    expect(body.batch[0].event).toBe("$pageview");
    expect(body.batch[0].properties.$browser).toBe("Chrome");
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).marker).toBe(
      FORWARD_OK_MARKER,
    );
  });

  it("never throws: ingest failure and non-2xx both WARN + 'failed'", async () => {
    getPosthogApiKey.mockResolvedValue("phc_key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      await forwardClientEvent(
        report(),
        {},
        {
          fetchImpl: vi.fn().mockRejectedValue(new Error("boom")),
          config,
        },
      ),
    ).toBe("failed");
    expect(
      await forwardClientEvent(
        report(),
        {},
        {
          fetchImpl: vi.fn().mockResolvedValue(response(false, 503)),
          config,
        },
      ),
    ).toBe("failed");
    for (const call of warn.mock.calls) {
      expect(JSON.parse(String(call[0])).marker).toBe(FORWARD_FAILED_MARKER);
    }
  });

  it("reports secret fetch failures without throwing", async () => {
    getPosthogApiKey.mockRejectedValue(new Error("kms"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await forwardClientEvent(report(), {}, { config })).toBe("failed");
    expect(JSON.parse(String(warn.mock.calls[0]?.[0])).reason).toBe(
      "secret_fetch_failed",
    );
  });
});
