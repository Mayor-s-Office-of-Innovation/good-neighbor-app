import { beforeAll, describe, expect, it } from "vitest";
import { handler } from "../src/lambda/api.js";
import { getCheck } from "../src/handlers/checks.js";

/*
  Contract test (api-response-integrity plan §4): the API's error responses
  must be JSON with the JSON content-type — an HTML error body (or a proxy
  rewriting one into the SPA) breaks the frontend's non-JSON guard and is
  exactly the 2026-09-14 dev incident shape. Sampled at the handler level;
  the platform-level rewrite is guarded by the CI deploy smoke check.
*/

beforeAll(() => {
  // getConfig() requires these; this test exercises only the error paths
  // that run before any AWS call.
  process.env.S3_UPLOAD_BUCKET ??= "test-bucket";
  process.env.SQS_QUEUE_URL ??= "https://queue.local/1";
  process.env.DYNAMO_TABLE ??= "test-table";
});

describe("API JSON content-type contract", () => {
  it("unknown route → JSON 404 with the JSON content-type", async () => {
    const res = await handler({ routeKey: "GET /nope" });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it("getCheck missing checkId → JSON 400 (error path is JSON-shaped)", async () => {
    const res = await getCheck({ pathParameters: {} });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.any(String) });
  });
});
