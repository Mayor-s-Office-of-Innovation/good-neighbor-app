import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.fn();
vi.mock("./feedback-forwarder.js", () => ({
  /**
   * @param {...unknown} args
   * @returns {unknown} passthrough to the mock fn
   */
  forwardFeedback: (...args) => forward(...args),
}));

const { handler, RECEIVED_MARKER, DROPPED_MARKER } = await import(
  "./feedback.js"
);
const { MAX_MESSAGE, MAX_SITE } = await import("./scrub-feedback.js");

/**
 * Build a proxy event with a JSON body.
 * @param {unknown} body
 * @param {{ headers?: Record<string, string>, rawBody?: string }} [opts]
 * @returns {{ routeKey: string, headers: Record<string, string>, body?: string }}
 */
function event(body, { headers = { "user-agent": "TestUA/1.0" } } = {}) {
  return {
    routeKey: "POST /v1/feedback",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/**
 * Most recent console.log call (the feedback line).
 * @param {ReturnType<typeof vi.spyOn>} logSpy
 * @returns {any} parsed JSON of the last log line
 */
function lastLog(logSpy) {
  return JSON.parse(/** @type {string} */ (logSpy.mock.calls.at(-1)?.[0]));
}

/**
 * Call the handler with the full (event, context, callback) lambda signature —
 * any-cast like guidance.test.js's `invoke`, since the handler type is a
 * union void|result and tests only see the result.
 * @param {unknown} event
 * @returns {Promise<any>}
 */
async function callHandler(event) {
  return handler(
    /** @type {any} */ (event),
    /** @type {any} */ ({}),
    /** @type {any} */ (() => {}),
  );
}

describe("feedback handler", () => {
  /** @type {ReturnType<typeof vi.spyOn> | undefined} */
  let logSpy;
  /** @type {ReturnType<typeof vi.spyOn> | undefined} */
  let warnSpy;

  afterEach(() => {
    forward.mockReset();
    logSpy?.mockRestore();
    warnSpy?.mockRestore();
  });

  it("logs a metadata-only FeedbackReceived line, forwards, 204", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await callHandler(
      event({
        message: "  Love the app, but photos are slow.  ",
        page: "/today",
        site: "M0101",
        release: "abc123",
        id: "uuid-1",
        ts: "2026-08-31T00:00:00Z",
      }),
    );

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(logSpy).toHaveBeenCalledTimes(1);

    const line = lastLog(logSpy);
    expect(line).toEqual(
      expect.objectContaining({
        level: "info",
        marker: RECEIVED_MARKER,
        page: "/today",
        site: "M0101",
        release: "abc123",
        id: "uuid-1",
        userAgent: "TestUA/1.0",
        textLength: 34,
      }),
    );
    // The message text must NOT be in the log line: PostHog is the feedback
    // store; CloudWatch carries operational metadata only (plan amendment).
    expect("text" in line).toBe(false);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(/** @type {any} */ (forward.mock.calls[0][0])).toMatchObject({
      text: "Love the app, but photos are slow.",
      page: "/today",
      site: "M0101",
      id: "uuid-1",
    });
    expect(/** @type {any} */ (forward.mock.calls[0][1])).toEqual({
      userAgent: "TestUA/1.0",
    });
  });

  it("forwards carry the same user-agent extracted for the log line", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callHandler(
      /** @type {any} */ (
        event(
          { message: "hi", id: "uuid-9" },
          { headers: { "User-Agent": "TestUA/2.0" } },
        )
      ),
    );

    expect(/** @type {any} */ (forward.mock.calls.at(-1)?.[1])).toEqual({
      userAgent: "TestUA/2.0",
    });
  });

  it.each([
    ["missing id", { message: "hi" }],
    ["empty id", { message: "hi", id: "" }],
    ["non-string id", { message: "hi", id: 42 }],
  ])(
    "drops submissions without a usable id (%s) — distinct_id is required",
    async (_name, body) => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await callHandler(event(body));

        expect(res.statusCode).toBe(204);
        expect(forward).not.toHaveBeenCalled();
        expect(
          JSON.parse(/** @type {string} */ (warnSpy.mock.calls[0]?.[0])).marker,
        ).toBe(DROPPED_MARKER);
      } finally {
        warnSpy.mockRestore();
        logSpy.mockRestore();
      }
    },
  );

  it.each([
    ["non-object body", "nope"],
    ["array body", []],
    ["missing message", { page: "/today" }],
    ["empty message", { message: "" }],
    ["whitespace-only message", "   \n\t  "],
    ["non-string message", { message: 42 }],
  ])("drops garbage (%s), still 204, dropped marker", async (_name, body) => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await callHandler(event(body));

      expect(res.statusCode).toBe(204);
      expect(res.body).toBeUndefined();
      expect(logSpy).not.toHaveBeenCalled();
      expect(
        JSON.parse(/** @type {string} */ (warnSpy.mock.calls[0]?.[0])).marker,
      ).toBe(DROPPED_MARKER);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("drops malformed JSON with the dropped marker", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await callHandler({ body: "{not json" });

      expect(res.statusCode).toBe(204);
      expect(logSpy).not.toHaveBeenCalled();
      expect(
        JSON.parse(/** @type {string} */ (warnSpy.mock.calls[0]?.[0])).marker,
      ).toBe(DROPPED_MARKER);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("truncates oversized messages to the cap", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callHandler(event({ message: "m".repeat(5000), id: "uuid-1" }));

    const line = lastLog(logSpy);
    expect(line.textLength).toBe(MAX_MESSAGE);
    // The text itself rides only to the forwarder, already capped by the
    // scrubber.
    expect(/** @type {any} */ (forward.mock.calls.at(-1)?.[0])).toMatchObject({
      text: "m".repeat(MAX_MESSAGE),
    });
  });

  it("scrubs query strings out of page on intake", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callHandler(
      event({
        message: "hi",
        id: "uuid-1",
        page: "/today?email=a@b.c&token=secret",
      }),
    );

    expect(lastLog(logSpy).page).toBe("/today");
  });

  it("drops a site field that does not match the site-code shape", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callHandler(
      event({ message: "hi", id: "uuid-1", site: "<script>alert(1)</script>" }),
    );

    expect(lastLog(logSpy).site).toBeUndefined();
  });

  it("omits optional fields entirely when absent (no undefined noise)", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callHandler(event({ message: "hi", id: "uuid-1" }));

    const line = lastLog(logSpy);
    for (const key of ["page", "site", "release"]) {
      expect(key in line).toBe(false);
    }
    // `id` is required, so it IS on the line.
    expect(line.id).toBe("uuid-1");
    expect(typeof line.ts).toBe("string");
  });

  it("extracts user-agent case-insensitively", async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await callHandler(
      /** @type {any} */ (
        event(
          { message: "hi", id: "uuid-1" },
          { headers: { "User-Agent": "TestUA/2.0" } },
        )
      ),
    );

    expect(lastLog(logSpy).userAgent).toBe("TestUA/2.0");
  });

  it("never throws — a malformed event still 204s", async () => {
    const res = await callHandler(null);
    expect(res.statusCode).toBe(204);
  });

  // The scrubber is the security boundary; assert its constants directly so a
  // cap change is a conscious act (mirrors the error intake's table-tests).
  it("keeps the settled field caps", async () => {
    expect(MAX_MESSAGE).toBe(2000);
    expect(MAX_SITE).toBe(32);
  });
});
