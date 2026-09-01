import { afterEach, describe, expect, it, vi } from "vitest";

const getPosthogApiKey = vi.fn();
vi.mock("./posthog-api-key.js", () => ({
  /**
   * @param {...unknown} args
   * @returns {unknown} passthrough to the mock fn
   */
  getPosthogApiKey: (...args) => getPosthogApiKey(...args),
}));

const {
  forwardClientError,
  toIso,
  parseStackFrames,
  FORWARD_FAILED_MARKER,
  FORWARD_OK_MARKER,
} = await import("./forwarder.js");

/**
 * Build a scrubbed report shape for forwarder input.
 * @param {Partial<import("./scrub-client-error.js").ScrubbedErrorReport>} [over]
 * @returns {import("./scrub-client-error.js").ScrubbedErrorReport}
 */
function report(over = {}) {
  return {
    type: "Error",
    message: "boom",
    id: "uuid-1",
    ...over,
  };
}

/** Minimal config so getConfig() never runs in forwarder unit tests. */
const config = { uploadBucket: "b", queueUrl: "q", dynamoTable: "t" };

describe("forwardClientError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    getPosthogApiKey.mockReset();
    vi.restoreAllMocks();
  });

  it("log-only mode (no key): logs and reports log-only, never fetches", async () => {
    getPosthogApiKey.mockResolvedValue(undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchImpl = vi.fn();

    const outcome = await forwardClientError(
      report(),
      { userAgent: "UA" },
      { fetchImpl, config },
    );

    expect(outcome).toBe("log-only");
    expect(fetchImpl).not.toHaveBeenCalled();
    const line = /** @type {string} */ (log.mock.calls[0][0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      marker: "ClientErrorLogOnly",
      message: "boom",
    });
  });

  it("forwards a mapped $exception batch event with the strict schema", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const outcome = await forwardClientError(
      report({
        stack:
          "Error: boom\n    at inner (/assets/app.js:2:15)\n    at outer (/assets/app.js:9:3)",
        source: "/check",
        release: "abc123",
        ts: "2026-08-31T10:00:00.000Z",
      }),
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
    // sent_at (snake case) — the field the ingestion API reads.
    expect(body.sent_at).toBe("2023-11-14T22:13:20.000Z");
    const [evt] = body.batch;
    expect(evt.event).toBe("$exception");
    expect(evt.distinct_id).toBe("uuid-1");
    expect(evt.timestamp).toBe("2026-08-31T10:00:00.000Z");
    // Strict schema: $exception_list with structured frames; no legacy flat props.
    const [exception] = evt.properties.$exception_list;
    expect(exception).toMatchObject({
      type: "Error",
      value: "boom",
      mechanism: { handled: false, synthetic: true },
    });
    // Innermost (throw site) last — reversed V8 order.
    expect(exception.stacktrace.frames).toEqual([
      { filename: "/assets/app.js", lineno: 9, colno: 3, function: "outer" },
      { filename: "/assets/app.js", lineno: 2, colno: 15, function: "inner" },
    ]);
    expect(evt.properties.release).toBe("abc123");
    expect(evt.properties.app_source).toBe("/check");
    expect(evt.properties.$process_person_profile).toBe(false);
    // Dual storage: forwarded reports also log an INFO line to CloudWatch.
    const line = JSON.parse(/** @type {string} */ (log.mock.calls[0][0]));
    expect(line).toMatchObject({
      level: "info",
      marker: FORWARD_OK_MARKER,
      type: "Error",
      message: "boom",
    });
  });

  it("never throws on fetch failure: WARN marker + 'failed', still no throw", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const outcome = await forwardClientError(
      report(),
      {},
      { fetchImpl, host: "https://ph.example", config },
    );

    expect(outcome).toBe("failed");
    const line = JSON.parse(/** @type {string} */ (warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      marker: FORWARD_FAILED_MARKER,
      type: "Error",
      message: "boom",
    });
  });

  it("treats non-2xx ingest responses as failures (still 204 upstream)", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    const outcome = await forwardClientError(
      report(),
      {},
      { fetchImpl, host: "https://ph.example", config },
    );

    expect(outcome).toBe("failed");
    const line = JSON.parse(/** @type {string} */ (warn.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      marker: FORWARD_FAILED_MARKER,
      type: "Error",
      message: "boom",
    });
  });

  it("times out slow ingests after ~3s", async () => {
    getPosthogApiKey.mockResolvedValue("phc_test");
    vi.useFakeTimers();
    try {
      const fetchImpl = /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
          vi.fn().mockImplementation(
            () =>
              new Promise((resolve) => {
                setTimeout(
                  () => resolve(/** @type {any} */ ({ ok: true })),
                  10_000,
                );
              }),
          )
        )
      );

      vi.spyOn(console, "warn").mockImplementation(() => {});
      const promise = forwardClientError(
        report(),
        {},
        { fetchImpl, host: "https://ph.example", config },
      );
      const pending = expect(promise).resolves.toBe("failed");
      // Fire the timeout race on the fake clock.
      await vi.advanceTimersByTimeAsync(3500);
      const outcome = await promise;

      expect(outcome).toBe("failed");
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("toIso", () => {
  it("normalizes parseable timestamps, rejects the rest", () => {
    expect(toIso("2026-08-31T10:00:00.000Z")).toBe("2026-08-31T10:00:00.000Z");
    expect(toIso("garbage")).toBeUndefined();
    expect(toIso(undefined)).toBeUndefined();
  });
});

describe("parseStackFrames", () => {
  it("parses V8 frames (fn + location), reversed to outermost-first", () => {
    const frames = parseStackFrames(
      "Error: boom\n    at inner (/assets/app.js:2:15)\n    at outer (/assets/app.js:9:3)",
    );
    expect(frames).toEqual([
      { filename: "/assets/app.js", lineno: 9, colno: 3, function: "outer" },
      { filename: "/assets/app.js", lineno: 2, colno: 15, function: "inner" },
    ]);
  });

  it("parses V8 location-only frames and Firefox @ frames", () => {
    const frames = parseStackFrames(
      "Error: boom\n    at /assets/app.js:2:15\nouter@/assets/app.js:9:3",
    );
    expect(frames).toEqual([
      { filename: "/assets/app.js", lineno: 9, colno: 3, function: "outer" },
      { filename: "/assets/app.js", lineno: 2, colno: 15 },
    ]);
  });

  it("skips the message line and blank lines; parses real frames", () => {
    // The message line is not a frame — PostHog carries it in type/value.
    const frames = parseStackFrames("Error: boom\n    at f (/a.js:1:1)");
    expect(frames).toEqual([
      { filename: "/a.js", lineno: 1, colno: 1, function: "f" },
    ]);
    expect(parseStackFrames("")).toEqual([]);
    expect(parseStackFrames("Error: only a message")).toEqual([]);
  });
});
