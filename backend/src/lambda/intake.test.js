import { afterEach, describe, expect, it, vi } from "vitest";

const clientErrors = vi.fn(async () => ({ statusCode: 204 }));
const clientEvents = vi.fn(async () => ({ statusCode: 204 }));
const feedback = vi.fn(async () => ({ statusCode: 204 }));
vi.mock("../handlers/client-errors.js", () => ({ handler: clientErrors }));
vi.mock("../handlers/client-events.js", () => ({ handler: clientEvents }));
vi.mock("../handlers/feedback.js", () => ({ handler: feedback }));

const { handler, routes } = await import("./intake.js");

/**
 * Call the entrypoint with the full lambda signature.
 * @param {string} routeKey
 * @returns {Promise<import("aws-lambda").APIGatewayProxyStructuredResultV2>}
 */
async function call(routeKey) {
  const result = await handler(
    /** @type {import("aws-lambda").APIGatewayProxyEventV2} */ (
      /** @type {unknown} */ ({ routeKey, body: "{}", headers: {} })
    ),
    /** @type {import("aws-lambda").Context} */ ({}),
    /** @type {import("aws-lambda").Callback} */ (() => {}),
  );
  return /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (
    result
  );
}

describe("intake Lambda entrypoint", () => {
  afterEach(() => {
    clientErrors.mockClear();
    clientEvents.mockClear();
    feedback.mockClear();
  });

  it("serves exactly the three best-effort intakes", () => {
    expect(Object.keys(routes).sort()).toEqual([
      "POST /v1/client-errors",
      "POST /v1/client-events",
      "POST /v1/feedback",
    ]);
  });

  it("dispatches each route to its handler", async () => {
    expect(await call("POST /v1/client-events")).toEqual({ statusCode: 204 });
    expect(clientEvents).toHaveBeenCalledTimes(1);
    expect(await call("POST /v1/client-errors")).toEqual({ statusCode: 204 });
    expect(clientErrors).toHaveBeenCalledTimes(1);
    expect(await call("POST /v1/feedback")).toEqual({ statusCode: 204 });
    expect(feedback).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for anything else", async () => {
    const res = await call("GET /v1/checks");
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? "")).toEqual({
      error: "not_found",
      routeKey: "GET /v1/checks",
    });
  });
});
