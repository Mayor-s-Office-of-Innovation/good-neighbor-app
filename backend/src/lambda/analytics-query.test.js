import { describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({
  handlers: {
    listAnalyticsQueries: vi.fn(async () => ({
      statusCode: 200,
      body: "list",
    })),
    runAnalyticsCatalogQuery: vi.fn(async () => ({
      statusCode: 200,
      body: "catalog",
    })),
    runAnalyticsQuery: vi.fn(async () => ({ statusCode: 200, body: "raw" })),
  },
}));
vi.mock("../handlers/admin-analytics.js", () => handlers);

const { handler } = await import("./analytics-query.js");

/**
 * @param {string} routeKey
 * @returns {any}
 */
const event = (routeKey) => ({
  routeKey,
  requestContext: { requestId: "req-1" },
});

describe("analytics-query lambda", () => {
  it.each([
    ["GET /admin/v1/analytics/queries", "listAnalyticsQueries", "list"],
    [
      "POST /admin/v1/analytics/queries/{queryId}",
      "runAnalyticsCatalogQuery",
      "catalog",
    ],
    ["POST /admin/v1/analytics/query", "runAnalyticsQuery", "raw"],
  ])("dispatches %s", async (routeKey, name, body) => {
    const res = await handler(
      event(routeKey),
      /** @type {any} */ ({}),
      () => {},
    );
    expect(res).toEqual({ statusCode: 200, body });
    expect(
      handlers[/** @type {keyof typeof handlers} */ (name)],
    ).toHaveBeenCalledWith(event(routeKey));
  });

  it("404s on any other route key", async () => {
    const res = /** @type {any} */ (
      await handler(
        event("GET /admin/v1/providers"),
        /** @type {any} */ ({}),
        () => {},
      )
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(String(res.body)).error).toBe("not_found");
  });
});
