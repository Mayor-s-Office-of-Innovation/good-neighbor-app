import { beforeEach, describe, it, expect, vi } from "vitest";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({
  getDynamoTableName: () => "table",
  getConfig: () => ({ uploadBucket: "bucket" }),
}));
vi.mock("../s3.js", () => ({
  presignGet: vi.fn(async () => "https://example.test/photo"),
}));
import {
  getSystemStatus,
  getStatusEntries,
  getStatusMedia,
  getStatusDuplicate,
} from "./system-status.js";
const event = (role = "compliance-supervisor", extra = {}) =>
  /** @type {any} */ ({
    requestContext: {
      authorizer: { jwt: { claims: { "cognito:groups": role } } },
    },
    ...extra,
  });
const invoke = (/** @type {any} */ fn, /** @type {any} */ ev) =>
  fn(ev, {}, () => {});
beforeEach(() => {
  send.mockReset();
  vi.useRealTimers();
});
describe("supervisor system status", () => {
  it.each([
    getSystemStatus,
    getStatusEntries,
    getStatusMedia,
    getStatusDuplicate,
  ])("rejects manager requests before touching data", async (handler) => {
    const result = await invoke(handler, event("compliance-manager"));
    expect(result.statusCode).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not present uninitialized reporting as zero", async () => {
    send.mockResolvedValue({});
    expect((await invoke(getSystemStatus, event())).statusCode).toBe(503);
  });
  it("includes inactive sites, pending analysis, all directory pages and final retry outcomes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T18:30:00Z"));
    send.mockImplementation(async (command) => {
      const input = command.input;
      if (input.Key?.pk === "SYSTEM#STATUS")
        return { Item: { ready: true, trackingSince: "2026-10-20T00:00:00Z" } };
      if (input.RequestItems)
        return {
          Responses: {
            table: [{ checkId: "c", artifactId: "a", status: "analyzed" }],
          },
        };
      const pk = input.ExpressionAttributeValues?.[":pk"];
      if (pk === "STATUS_SITES")
        return input.ExclusiveStartKey
          ? {
              Items: [
                { siteId: "inactive", name: "Inactive", status: "inactive" },
              ],
            }
          : {
              Items: [{ siteId: "one", name: "One" }],
              LastEvaluatedKey: { pk, sk: "one" },
            };
      if (pk === "STATUS#one")
        return {
          Items: ["a", "b"].map((artifactId) => ({
            kind: "submissions",
            at: "2026-10-24T18:00:00Z",
            checkId: "c",
            artifactId,
          })),
        };
      return { Items: [] };
    });
    const result = JSON.parse((await invoke(getSystemStatus, event())).body);
    expect(result.sites).toHaveLength(2);
    expect(result.network).toEqual({ state: "orange", percent: 50 });
    expect(result.analysis).toEqual({ state: "green", percent: 100 });
    expect(result.pending).toBe(1);
    expect(result.start).toBe("2026-10-24T07:00:00.000Z");
  });
  it("counts network activity only since Pacific midnight, including its boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T18:30:00Z"));
    send.mockImplementation(async (command) => {
      const input = command.input;
      if (input.Key?.pk === "SYSTEM#STATUS") return { Item: { ready: true } };
      if (input.RequestItems) return { Responses: { table: [] } };
      const values = input.ExpressionAttributeValues;
      if (values?.[":pk"] === "STATUS_SITES")
        return { Items: [{ siteId: "yesterday" }, { siteId: "today" }] };
      expect(values[":from"]).toBe("2026-10-24T07:00:00.000Z");
      const at =
        values[":pk"] === "STATUS#yesterday"
          ? "2026-10-24T06:59:59.999Z"
          : "2026-10-24T07:00:00.000Z";
      return {
        Items:
          at >= values[":from"]
            ? [{ kind: "submissions", at, checkId: "c", artifactId: "a" }]
            : [],
      };
    });
    const result = JSON.parse((await invoke(getSystemStatus, event())).body);
    expect(result.network).toEqual({ state: "orange", percent: 50 });
    expect(result.sites[0].active).toBe(false);
    expect(result.sites[1].active).toBe(true);
    expect(result.sites[0].counts.submissions).toBe(0);
    expect(result.sites[1].counts.submissions).toBe(1);
    expect(result.sites[1].submissionHours[0]).toBe(1);
  });
  it("rejects pagination cursors crossing sites", async () => {
    send.mockResolvedValue({ Item: { siteId: "one" } });
    const cursor = Buffer.from(
      JSON.stringify({ pk: "STATUS#other", sk: "x" }),
    ).toString("base64url");
    const result = await invoke(
      getStatusEntries,
      event(undefined, {
        pathParameters: { siteId: "one", kind: "submissions" },
        queryStringParameters: { cursor },
      }),
    );
    expect(result.statusCode).toBe(400);
  });
});
