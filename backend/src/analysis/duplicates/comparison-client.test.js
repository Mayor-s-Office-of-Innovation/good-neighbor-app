import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createComparisonClient } from "./comparison-client.js";
import { createComparisonPacer, comparisonWait } from "./request-pacing.js";

const request = {
  mode: "image",
  source: { id: "s" },
  candidates: [{ id: "c" }],
};
const body = {
  comparisons: [],
  comparison_version: "test",
  model: { model_id: "test" },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(globalThis.AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new globalThis.AbortController();
    setTimeout(() => controller.abort(new Error("deadline")), ms);
    return controller.signal;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * @param {typeof fetch} fetchImpl
 * @param {Partial<Parameters<typeof createComparisonClient>[0]>} options
 * @returns {ReturnType<typeof createComparisonClient>}
 */
function client(fetchImpl, options = {}) {
  return createComparisonClient({
    baseUrl: "https://example.test/dev/",
    apiKey: "secret",
    fetchImpl,
    ...options,
  });
}

it("retries only 429s, paces every attempt and preserves the request and final response", async () => {
  /** @type {number[]} */ const starts = [];
  const fetchImpl = vi.fn().mockImplementation(async () => {
    starts.push(Date.now());
    return starts.length < 3
      ? new Response("throttled", { status: 429 })
      : Response.json(body);
  });
  const pace = vi.fn(async () => {});
  const pending = client(fetchImpl, { pace })(request);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual(body);
  expect(starts).toEqual([100000, 100375, 101000]);
  expect(pace).toHaveBeenCalledTimes(3);
  expect(
    fetchImpl.mock.calls.every(
      ([, options]) => options.body === JSON.stringify(request),
    ),
  ).toBe(true);
});

it.each(["2", new Date(102000).toUTCString()])(
  "honors Retry-After %s",
  async (header) => {
    /** @type {number[]} */ const starts = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      starts.push(Date.now());
      return starts.length === 1
        ? new Response(null, {
            status: 429,
            headers: { "Retry-After": header },
          })
        : Response.json(body);
    });
    const pending = client(fetchImpl)(request);
    await vi.advanceTimersByTimeAsync(2200);
    await pending;
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(2000);
  },
);

it("caps attempts at four even for persistent throttling", async () => {
  const fetchImpl = vi.fn(async () => new Response(null, { status: 429 }));
  const pending = expect(client(fetchImpl)(request)).rejects.toThrow(
    "Comparison HTTP 429",
  );
  await vi.advanceTimersByTimeAsync(3000);
  await pending;
  expect(fetchImpl).toHaveBeenCalledTimes(4);
});

it.each([400, 403, 422, 500, 503])("does not retry HTTP %s", async (status) => {
  const fetchImpl = vi.fn(async () => new Response(null, { status }));
  await expect(client(fetchImpl)(request)).rejects.toThrow(
    `Comparison HTTP ${status}`,
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it("does not retry transport errors or malformed success JSON", async () => {
  const failed = vi.fn(async () => {
    throw new Error("network");
  });
  await expect(client(failed)(request)).rejects.toThrow("network");
  expect(failed).toHaveBeenCalledTimes(1);
  const malformed = vi.fn(async () => new Response("not json"));
  await expect(client(malformed)(request)).rejects.toThrow();
  expect(malformed).toHaveBeenCalledTimes(1);
});

it.each(["3600", "2147484"])(
  "bounds Retry-After %s by the shared deadline without retrying early",
  async (retryAfter) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
    );
    const pending = expect(
      client(fetchImpl, { deadlineMs: 1000 })(request),
    ).rejects.toThrow("deadline");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  },
);

it("includes pacing in the deadline and never fetches after it expires", async () => {
  const fetchImpl = vi.fn(async () => Response.json(body));
  const pending = expect(
    client(fetchImpl, {
      deadlineMs: 1000,
      pace: (signal) => comparisonWait(2000, signal),
    })(request),
  ).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("does not reset the total deadline after a throttled attempt", async () => {
  /** @type {number[]} */ const starts = [];
  const fetchImpl = vi.fn().mockImplementation(async (_url, { signal }) => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response(null, { status: 429 });
    await comparisonWait(2000, signal);
    return Response.json(body);
  });
  const pending = expect(
    client(fetchImpl, { deadlineMs: 1000 })(request),
  ).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(starts).toHaveLength(2);
});

it("keeps the per-attempt timeout through response body consumption", async () => {
  const fetchImpl = vi.fn().mockImplementation(async (_url, { signal }) => ({
    ok: true,
    json: async () => {
      await comparisonWait(2000, signal);
      return body;
    },
  }));
  const pending = expect(
    client(fetchImpl, { attemptTimeoutMs: 500 })(request),
  ).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

/**
 * A shared atomic conditional-write store represents independent Lambda clients.
 * @returns {{ddb:import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,starts:number[],send:import("vitest").Mock}}
 */
function permitStore() {
  let nextAllowedAt = 0;
  /** @type {number[]} */ const starts = [];
  const send = vi.fn(async (command) => {
    const input = command.input;
    if (input.UpdateExpression) {
      const now = input.ExpressionAttributeValues[":now"];
      if (nextAllowedAt > now)
        throw Object.assign(new Error(), {
          name: "ConditionalCheckFailedException",
        });
      nextAllowedAt = input.ExpressionAttributeValues[":next"];
      starts.push(now);
      return {};
    }
    return { Item: { nextAllowedAt } };
  });
  return {
    ddb: /** @type {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} */ (
      /** @type {unknown} */ ({ send })
    ),
    starts,
    send,
  };
}

it("paces multiple independent clients and their retries through one shared gate", async () => {
  const store = permitStore();
  const clients = Array.from({ length: 8 }, () => {
    let calls = 0;
    return client(
      vi.fn(async () =>
        ++calls === 1
          ? new Response(null, { status: 429 })
          : Response.json(body),
      ),
      {
        pace: createComparisonPacer({
          ddb: store.ddb,
          table: "test",
          baseUrl: "https://example.test/dev",
          requestsPerSecond: 3,
        }),
      },
    );
  });
  const pending = Promise.all(clients.map((compare) => compare(request)));
  await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toHaveLength(8);
  expect(store.starts).toHaveLength(16);
  expect(
    store.starts.slice(1).every((start, i) => start - store.starts[i] >= 334),
  ).toBe(true);
  const writes = store.send.mock.calls.filter(
    ([command]) => command.input.UpdateExpression,
  );
  expect(
    new Set(writes.map(([command]) => JSON.stringify(command.input.Key))).size,
  ).toBe(1);
});

it("fails closed on DynamoDB errors and bounds waits for a busy shared gate", async () => {
  const store = permitStore();
  store.send.mockRejectedValueOnce(new Error("denied"));
  const pace = createComparisonPacer({
    ddb: store.ddb,
    table: "test",
    baseUrl: "https://example.test/dev/",
    requestsPerSecond: 0.1,
  });
  const fetchImpl = vi.fn(async () => Response.json(body));
  await expect(client(fetchImpl, { pace })(request)).rejects.toThrow("denied");
  await client(fetchImpl, { pace })(request);
  const pending = expect(
    client(fetchImpl, { pace, deadlineMs: 500 })(request),
  ).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each([0, -1, NaN, 33])(
  "rejects invalid pacing rate %s",
  (requestsPerSecond) => {
    expect(() =>
      createComparisonPacer({
        ddb: permitStore().ddb,
        table: "test",
        baseUrl: "https://example.test",
        requestsPerSecond,
      }),
    ).toThrow("Invalid comparison pacing");
  },
);
