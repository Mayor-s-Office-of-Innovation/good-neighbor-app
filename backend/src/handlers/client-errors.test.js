import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.fn();
vi.mock("./forwarder.js", () => ({
  forwardClientError: forward,
}));

const { handler, DROPPED_MARKER } = await import("./client-errors.js");

/**
 * Build a proxy event with a JSON body.
 * @param {unknown} body
 * @param {{ headers?: Record<string, string> }} [opts]
 * @returns {{ routeKey: string, headers: Record<string, string>, body: string }}
 */
function event(body, { headers = { "user-agent": "TestUA/1.0" } } = {}) {
  return {
    routeKey: "POST /v1/client-errors",
    headers,
    body: JSON.stringify(body),
  };
}

/**
 * Most recent forwarded report.
 * @returns {any} last call's report argument
 */
function lastReport() {
  return /** @type {any} */ (forward.mock.calls.at(-1)?.[0]);
}

/**
 * Most recent forwarder context.
 * @returns {{ userAgent?: string }} last call's context arg
 */
function lastContext() {
  return /** @type {{ userAgent?: string }} */ (
    forward.mock.calls.at(-1)?.[1] ?? {}
  );
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

describe("client-errors handler", () => {
  afterEach(() => {
    forward.mockReset();
  });

  it("accepts a valid report: forwards it and returns 204", async () => {
    const res = await callHandler(
      event({
        type: "Error",
        message: "boom",
        stack: "Error: boom\n    at f (/check:1:1)",
        source: "/check",
        release: "abc123",
        id: "uuid-1",
      }),
    );

    expect(res.statusCode).toBe(204);
    expect(res.body).toBeUndefined();
    expect(lastReport()).toEqual(
      expect.objectContaining({
        type: "Error",
        message: "boom",
        source: "/check",
        release: "abc123",
      }),
    );
  });

  it.each([
    ["non-object body", "nope"],
    ["array body", []],
    ["missing type", { message: "x", id: "u1" }],
    ["bad type", { type: "Warning", message: "x", id: "u1" }],
    ["missing message", { type: "Error", id: "u1" }],
    ["missing id", { type: "Error", message: "x" }],
    ["non-string message", { type: "Error", message: 42, id: "u1" }],
  ])("drops garbage (%s), still 204, no forward", async (_name, body) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await callHandler(event(body));

      expect(res.statusCode).toBe(204);
      expect(res.body).toBeUndefined();
      expect(forward).not.toHaveBeenCalled();
      expect(
        JSON.parse(/** @type {string} */ (warn.mock.calls[0]?.[0])).marker,
      ).toBe(DROPPED_MARKER);
    } finally {
      warn.mockRestore();
    }
  });

  it("drops malformed JSON with the dropped marker", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await callHandler({ body: "{not json" });

      expect(res.statusCode).toBe(204);
      expect(forward).not.toHaveBeenCalled();
      expect(
        JSON.parse(/** @type {string} */ (warn.mock.calls[0]?.[0])).marker,
      ).toBe(DROPPED_MARKER);
    } finally {
      warn.mockRestore();
    }
  });

  it("scrubs query strings out of source on intake", async () => {
    const res = await callHandler(
      event({
        type: "Error",
        message: "x",
        id: "u1",
        source: "/check?site=123&email=a@b.c",
      }),
    );

    expect(res.statusCode).toBe(204);
    expect(lastReport()).toEqual(expect.objectContaining({ source: "/check" }));
  });

  it("truncates oversized message and stack", async () => {
    await callHandler(
      event({
        type: "Error",
        message: "m".repeat(5000),
        stack: "s".repeat(20000),
        id: "u1",
      }),
    );

    const report = lastReport();
    expect(report.message.length).toBeLessThanOrEqual(2000);
    expect(report.stack.length).toBeLessThanOrEqual(16000);
  });

  it("never throws — a malformed event still 204s", async () => {
    const res = await callHandler(null);
    expect(res.statusCode).toBe(204);
  });

  it("extracts user-agent case-insensitively", async () => {
    await callHandler(
      /** @type {any} */ (
        event(
          { type: "Error", message: "x", id: "u1" },
          { headers: { "User-Agent": "TestUA/2.0" } },
        )
      ),
    );

    expect(lastContext().userAgent).toBe("TestUA/2.0");
  });
});
