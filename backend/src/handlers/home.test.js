import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The loaders are covered through their own routes (tasks.test.js and
// checks.test.js); here they are spies so the tests exercise the aggregation:
// fan-out, per-section results, the all-failed case, and site isolation.
const { loadChecks, loadTaskWorklist } = vi.hoisted(() => ({
  loadChecks: vi.fn(),
  loadTaskWorklist: vi.fn(),
}));
vi.mock("./checks.js", () => ({ loadChecks }));
vi.mock("./tasks.js", () => ({ loadTaskWorklist }));

const { getHome, HOME_TASK_STATUSES } = await import("./home.js");

/**
 * @param {object} opts
 * @param {string} [opts.siteClaim] custom:siteId JWT claim
 * @param {Record<string, string>} [opts.query] queryStringParameters
 * @returns {import("aws-lambda").APIGatewayProxyEventV2WithJWTAuthorizer}
 */
function readEvent({ siteClaim = "site-1", query } = {}) {
  return /** @type {any} */ ({
    ...(query ? { queryStringParameters: query } : {}),
    requestContext: {
      requestId: "req-1",
      authorizer: { jwt: { claims: { "custom:siteId": siteClaim } } },
    },
  });
}

/**
 * @param {any} event
 * @returns {Promise<any>}
 */
const invoke = (event) =>
  /** @type {any} */ (getHome(event, /** @type {any} */ ({}), () => {}));

/** @param {string} status */
const taskRow = (status) => ({ taskId: `t-${status}`, status });

describe("getHome", () => {
  beforeEach(() => {
    loadChecks.mockReset();
    loadTaskWorklist.mockReset();
    process.env.S3_UPLOAD_BUCKET = "bucket";
    process.env.SQS_QUEUE_URL = "queue";
    process.env.DYNAMO_TABLE = "gnp-test-app";
    loadChecks.mockResolvedValue({
      checks: [{ checkId: "chk_1" }],
      nextToken: "next",
    });
    loadTaskWorklist.mockImplementation(
      async (_table, _site, /** @type {string} */ status) => [taskRow(status)],
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns checks and every worklist in one body with per-section ok flags", async () => {
    const res = await invoke(readEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checks).toEqual({
      ok: true,
      items: [{ checkId: "chk_1" }],
      nextToken: "next",
    });
    expect(Object.keys(body.tasks)).toEqual([...HOME_TASK_STATUSES]);
    for (const status of HOME_TASK_STATUSES) {
      expect(body.tasks[status]).toEqual({
        ok: true,
        items: [taskRow(status)],
      });
    }
    expect(Number.isNaN(Date.parse(body.loadedAt))).toBe(false);
  });

  it("runs the five reads for the token's site with the default limits", async () => {
    await invoke(readEvent({ siteClaim: "site-9" }));

    expect(loadChecks).toHaveBeenCalledTimes(1);
    expect(loadChecks).toHaveBeenCalledWith("gnp-test-app", "site-9", {
      limit: 30,
    });
    expect(loadTaskWorklist).toHaveBeenCalledTimes(HOME_TASK_STATUSES.length);
    for (const status of HOME_TASK_STATUSES) {
      expect(loadTaskWorklist).toHaveBeenCalledWith(
        "gnp-test-app",
        "site-9",
        status,
        50,
      );
    }
  });

  it("honours checksLimit and tasksLimit and ignores a siteId in the query", async () => {
    await invoke(
      readEvent({
        siteClaim: "site-1",
        query: { checksLimit: "5", tasksLimit: "12", siteId: "site-other" },
      }),
    );

    expect(loadChecks).toHaveBeenCalledWith("gnp-test-app", "site-1", {
      limit: 5,
    });
    expect(loadTaskWorklist).toHaveBeenCalledWith(
      "gnp-test-app",
      "site-1",
      "open",
      12,
    );
    for (const call of loadTaskWorklist.mock.calls) {
      expect(call[1]).toBe("site-1");
    }
  });

  it("falls back to the default limits on unusable values", async () => {
    await invoke(readEvent({ query: { checksLimit: "0", tasksLimit: "abc" } }));

    expect(loadChecks).toHaveBeenCalledWith("gnp-test-app", "site-1", {
      limit: 30,
    });
    expect(loadTaskWorklist).toHaveBeenCalledWith(
      "gnp-test-app",
      "site-1",
      "open",
      50,
    );
  });

  it("runs and returns only the named sections", async () => {
    const res = await invoke(readEvent({ query: { sections: "checks,open" } }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.checks.ok).toBe(true);
    expect(Object.keys(body.tasks)).toEqual(["open"]);
    expect(loadChecks).toHaveBeenCalledTimes(1);
    expect(loadTaskWorklist).toHaveBeenCalledTimes(1);
    expect(loadTaskWorklist).toHaveBeenCalledWith(
      "gnp-test-app",
      "site-1",
      "open",
      50,
    );
  });

  it("leaves checks out when only task statuses are named", async () => {
    const res = await invoke(
      readEvent({ query: { sections: "in_progress, completing,completed" } }),
    );

    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("checks");
    expect(Object.keys(body.tasks)).toEqual([
      "in_progress",
      "completing",
      "completed",
    ]);
    expect(loadChecks).not.toHaveBeenCalled();
    expect(loadTaskWorklist).toHaveBeenCalledTimes(3);
  });

  it("rejects an unknown or empty sections list with a 400 before reading anything", async () => {
    for (const sections of ["checks,bogus", ",", "  "]) {
      const res = await invoke(readEvent({ query: { sections } }));
      if (sections.trim() === "") {
        // Blank means "everything", like an absent parameter.
        expect(res.statusCode).toBe(200);
        continue;
      }
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ error: "invalid_sections" });
    }
    expect(loadChecks).toHaveBeenCalledTimes(1);
  });

  it("throws when every named read fails, even with a subset", async () => {
    const outage = new Error("DynamoDB unreachable");
    loadTaskWorklist.mockRejectedValue(outage);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      invoke(readEvent({ query: { sections: "open,completed" } })),
    ).rejects.toBe(outage);
    // checks was not requested, so its (healthy) loader cannot rescue the call.
    expect(loadChecks).not.toHaveBeenCalled();
  });

  it("reports one failed worklist as ok:false and still returns the rest", async () => {
    const failure = new Error("throttled");
    failure.name = "ProvisionedThroughputExceededException";
    loadTaskWorklist.mockImplementation(
      async (_table, _site, /** @type {string} */ status) => {
        if (status === "completed") throw failure;
        return [taskRow(status)];
      },
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await invoke(readEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tasks.completed).toEqual({
      ok: false,
      error: "ProvisionedThroughputExceededException",
    });
    expect(body.tasks.open.ok).toBe(true);
    expect(body.checks.ok).toBe(true);
    // One structured error line for the failed section, none for the others.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logged.mock.calls[0][0])).toMatchObject({
      level: "ERROR",
      route: "api GET /v1/home tasks.completed",
      reqId: "req-1",
      message: "throttled",
    });
  });

  it("handles a task rejection while checks are still pending", () => {
    // Run the actual handler outside Vitest: mock promise tracking can mask
    // unhandled rejections, while Node must survive until checks resolve.
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-vm-modules",
        "--input-type=module",
        "-e",
        `
        import { readFileSync } from "node:fs";
        import { SourceTextModule, SyntheticModule } from "node:vm";
        const dependencies = {
          getConfig: () => ({ dynamoTable: "synthetic-table" }),
          deriveSiteId: () => "synthetic-site",
          parseLimit: () => undefined,
          jsonResponse: (statusCode, body) => ({ statusCode, body }),
          logServerError: () => {},
          loadChecks: () => new Promise(resolve => {
            setTimeout(() => resolve({ checks: [{ checkId: "chk_1" }] }), 20);
          }),
          loadTaskWorklist: async (_table, _site, status) => {
            if (status === "open") throw new Error("Synthetic task failure");
            return [{ taskId: "synthetic-" + status }];
          },
        };
        const handler = new SourceTextModule(readFileSync(${JSON.stringify(new URL("./home.js", import.meta.url).pathname)}, "utf8"));
        await handler.link(() => new SyntheticModule(Object.keys(dependencies), function () {
          for (const [name, value] of Object.entries(dependencies)) this.setExport(name, value);
        }));
        await handler.evaluate();
        console.log(JSON.stringify(await handler.namespace.getHome({})));
      `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const { statusCode, body } = JSON.parse(result.stdout);
    expect(statusCode).toBe(200);
    expect(body.checks).toEqual({ ok: true, items: [{ checkId: "chk_1" }] });
    expect(body.tasks.open).toEqual({ ok: false, error: "Error" });
    expect(body.tasks.completed.ok).toBe(true);
  });

  it("reports a failed checks read as ok:false while the worklists return", async () => {
    loadChecks.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const body = JSON.parse((await invoke(readEvent())).body);

    expect(body.checks).toEqual({ ok: false, error: "Error" });
    expect(body.tasks.open.ok).toBe(true);
  });

  it("throws when every read fails so the platform answers 5xx", async () => {
    const outage = new Error("DynamoDB unreachable");
    loadChecks.mockRejectedValue(outage);
    loadTaskWorklist.mockRejectedValue(outage);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(invoke(readEvent())).rejects.toBe(outage);
    // The router logs the thrown error once; no per-section lines on top.
    expect(logged).not.toHaveBeenCalled();
  });
});
