import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.fn();
vi.mock("./event-forwarder.js", () => ({
  forwardClientEvents: forward,
}));

const { handler, DROPPED_MARKER, MAX_BATCH } = await import(
  "./client-events.js"
);

/**
 * Build a proxy event with a JSON (or raw string) body.
 * @param {unknown} body
 * @param {{ headers?: Record<string, string> }} [opts]
 * @returns {{ routeKey: string, headers: Record<string, string>, body: string }}
 */
function event(body, { headers = { "User-Agent": "TestUA/1.0" } } = {}) {
  return {
    routeKey: "POST /v1/client-events",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

/**
 * Call the handler with the full lambda signature.
 * @param {unknown} e
 * @returns {Promise<unknown>}
 */
async function call(e) {
  return handler(
    /** @type {import("aws-lambda").APIGatewayProxyEventV2} */ (e),
    /** @type {import("aws-lambda").Context} */ ({}),
    /** @type {import("aws-lambda").Callback} */ (() => {}),
  );
}

describe("client-events handler", () => {
  afterEach(() => {
    forward.mockReset();
    vi.restoreAllMocks();
  });

  it("forwards a valid event with the caller's user agent and answers 204", async () => {
    forward.mockResolvedValue("forwarded");
    const res = await call(
      event({
        event: "camera_opened",
        id: "uuid-1",
        properties: { flow: "perimeter", secret: "x" },
      }),
    );
    expect(res).toEqual({ statusCode: 204 });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0][0]).toEqual([
      {
        event: "camera_opened",
        id: "uuid-1",
        properties: { flow: "perimeter" },
      },
    ]);
    expect(forward.mock.calls[0][1]).toEqual({ userAgent: "TestUA/1.0" });
  });

  it("prefers the envelope's user agent over the header", async () => {
    forward.mockResolvedValue("forwarded");
    await call(
      event({
        batch: [{ event: "camera_opened", id: "uuid-1", properties: {} }],
        ua: "EnvelopeUA/2.0",
      }),
    );
    expect(forward.mock.calls[0][1]).toEqual({ userAgent: "EnvelopeUA/2.0" });
  });

  it("forwards a batch in one call, dropping only the invalid items", async () => {
    forward.mockResolvedValue("forwarded");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await call(
      event({
        batch: [
          { event: "camera_opened", id: "uuid-1", properties: { flow: "p" } },
          { event: "nope", id: "uuid-1" },
          { event: "photo_picked", id: "uuid-1", properties: {} },
        ],
      }),
    );
    expect(res).toEqual({ statusCode: 204 });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(
      forward.mock.calls[0][0].map(
        (/** @type {{ event: string }} */ r) => r.event,
      ),
    ).toEqual(["camera_opened", "photo_picked"]);
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.marker).toBe(DROPPED_MARKER);
    expect(line.reason).toBe("invalid_items");
    expect(line.received).toBe(3);
    expect(line.dropped).toBe(1);
    expect(line.invalid).toBe(1);
    expect(line.truncated).toBe(0);
  });

  it("caps a batch at MAX_BATCH items and reports the excess as truncated", async () => {
    forward.mockResolvedValue("forwarded");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const batch = Array.from({ length: MAX_BATCH + 10 }, () => ({
      event: "$pageview",
      id: "uuid-1",
    }));
    await call(event({ batch }));
    expect(forward.mock.calls[0][0]).toHaveLength(MAX_BATCH);
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.received).toBe(MAX_BATCH + 10);
    expect(line.dropped).toBe(10);
    expect(line.invalid).toBe(0);
    expect(line.truncated).toBe(10);
  });

  it("treats an empty or malformed batch as garbage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await call(event({ batch: [] }))).toEqual({ statusCode: 204 });
    expect(await call(event({ batch: "x" }))).toEqual({ statusCode: 204 });
    expect(await call(event([{ event: "$pageview", id: "u" }]))).toEqual({
      statusCode: 204,
    });
    expect(forward).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("drops garbage with the marker, still 204, never forwards", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await call(event("{not json"))).toEqual({ statusCode: 204 });
    expect(await call(event({ event: "nope", id: "u" }))).toEqual({
      statusCode: 204,
    });
    expect(forward).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0])).marker).toBe(
      DROPPED_MARKER,
    );
  });

  it("tolerates a missing user agent", async () => {
    forward.mockResolvedValue("log-only");
    await call(event({ event: "$pageview", id: "u" }, { headers: {} }));
    expect(forward.mock.calls[0][1]).toEqual({ userAgent: undefined });
  });
});
