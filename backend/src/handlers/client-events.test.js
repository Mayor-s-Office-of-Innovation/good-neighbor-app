import { afterEach, describe, expect, it, vi } from "vitest";

const forward = vi.fn();
vi.mock("./event-forwarder.js", () => ({
  forwardClientEvent: forward,
}));

const { handler, DROPPED_MARKER } = await import("./client-events.js");

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
    expect(forward.mock.calls[0][0]).toEqual({
      event: "camera_opened",
      id: "uuid-1",
      properties: { flow: "perimeter" },
    });
    expect(forward.mock.calls[0][1]).toEqual({ userAgent: "TestUA/1.0" });
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
