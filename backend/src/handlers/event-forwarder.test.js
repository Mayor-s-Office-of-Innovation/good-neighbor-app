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
  forwardClientEvents,
  forwardClientEventGroups,
  toPosthogEvent,
  userAgentProperties,
  EVENT_FORWARD_TIMEOUT_MS,
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

const config = {};

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

  it("sends a request's events in one /batch/ call and logs each", async () => {
    getPosthogApiKey.mockResolvedValue("phc_key");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(response(true, 200));
    const outcome = await forwardClientEvents(
      [
        report(),
        report({ event: "camera_opened", properties: { flow: "perimeter" } }),
        report({ event: "photo_picked", properties: { flow: "perimeter" } }),
      ],
      { userAgent: ANDROID_UA },
      { fetchImpl, config, host: "https://ph.example", now: () => 0 },
    );
    expect(outcome).toBe("forwarded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(
      body.batch.map((/** @type {{event: string}} */ e) => e.event),
    ).toEqual(["$pageview", "camera_opened", "photo_picked"]);
    expect(body.batch[2].properties.$browser).toBe("Chrome");
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.marker === FORWARD_OK_MARKER)).toBe(true);
    expect(lines.every((l) => l.batch_size === 3)).toBe(true);
    expect(lines[1].event).toBe("camera_opened");
  });

  it("forwards several groups, each with its own user agent, in one call", async () => {
    getPosthogApiKey.mockResolvedValue("phc_key");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue(response(true, 200));
    const outcome = await forwardClientEventGroups(
      [
        {
          reports: [report(), report({ event: "camera_opened" })],
          ctx: { userAgent: ANDROID_UA },
        },
        {
          reports: [report({ id: "uuid-2" })],
          ctx: {
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
          },
        },
        { reports: [], ctx: {} },
      ],
      {
        fetchImpl,
        config,
        host: "https://ph.example",
        now: () => 0,
        timeoutMs: 5000,
      },
    );
    expect(outcome).toBe("forwarded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.batch).toHaveLength(3);
    expect(body.batch[0].properties.$os).toBe("Android");
    expect(body.batch[2].properties.$os).toBe("iOS");
    expect(body.batch[2].distinct_id).toBe("uuid-2");
    const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.batch_size === 3)).toBe(true);
  });

  it("treats a call with no events as log-only without fetching", async () => {
    const fetchImpl = vi.fn();
    expect(
      await forwardClientEventGroups([{ reports: [], ctx: {} }], {
        fetchImpl,
        config,
      }),
    ).toBe("log-only");
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it("keeps the event and its device properties on the failure line", async () => {
    getPosthogApiKey.mockResolvedValue("phc_key");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await forwardClientEvent(
      report(),
      { userAgent: ANDROID_UA },
      { fetchImpl: vi.fn().mockRejectedValue(new Error("boom")), config },
    );
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.event).toBe("$pageview");
    expect(line.properties.$os_version).toBe("8.0.0");
    expect(line.properties.$pathname).toBe("/check");
    expect(line.error).toBe("boom");
  });

  it("gives up on a slow ingest after its own 1 s budget", async () => {
    expect(EVENT_FORWARD_TIMEOUT_MS).toBe(1000);
    getPosthogApiKey.mockResolvedValue("phc_key");
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(response(true, 200)), 10_000);
          }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const promise = forwardClientEvent(report(), {}, { fetchImpl, config });
      await vi.advanceTimersByTimeAsync(1100);
      expect(await promise).toBe("failed");
      expect(JSON.parse(String(warn.mock.calls[0]?.[0])).error).toBe(
        "forwarder timeout",
      );
    } finally {
      vi.useRealTimers();
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

describe("abort on timeout", () => {
  it("carries the consumer's uuid through to PostHog", () => {
    const event = toPosthogEvent(
      report({ uuid: "11111111-2222-5333-8444-555555555555" }),
      {},
    );
    expect(event.uuid).toBe("11111111-2222-5333-8444-555555555555");
    expect(toPosthogEvent(report(), {})).not.toHaveProperty("uuid");
  });

  it("aborts the fetch when the budget expires, then reports failed", async () => {
    getPosthogApiKey.mockResolvedValue("phc_key");
    /** @typedef {{ aborted: boolean, addEventListener: (type: string, fn: () => void) => void }} Signal */
    /** @type {Signal | undefined} */
    let seen;
    const fetchImpl = vi.fn(
      (/** @type {string} */ _url, /** @type {{ signal?: Signal }} */ init) =>
        new Promise((_, reject) => {
          seen = init.signal;
          seen?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const outcome = await forwardClientEventGroups(
      [{ reports: [report()], ctx: {} }],
      {
        fetchImpl: /** @type {typeof fetch} */ (
          /** @type {unknown} */ (fetchImpl)
        ),
        config,
        host: "https://ph.example",
        timeoutMs: 10,
      },
    );
    expect(outcome).toBe("failed");
    expect(seen?.aborted).toBe(true);
  });
});
