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
  const pace = vi.fn(async (_signal, start) => ({ pending: start() }));
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
      pace: async (signal, start) => {
        await comparisonWait(2000, signal);
        return { pending: start() };
      },
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
 * Delays before commit and after commit model different DynamoDB failure paths.
 * @param {{claimDelays?:number[],claimResponseDelays?:number[],releaseDelays?:number[],releaseResponseDelays?:number[]}} [delays]
 * @returns {{ddb:import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient,starts:number[],send:import("vitest").Mock}}
 */
function permitStore(delays = {}) {
  /** @type {Map<string,{nextAllowedAt?:number,leaseUntil?:number,owner?:string}>} */
  const records = new Map();
  /** @type {number[]} */ const starts = [];
  let claims = 0,
    releases = 0;
  const send = vi.fn(async (command, { abortSignal }) => {
    const input = command.input;
    const key = JSON.stringify(input.Key);
    const values = input.ExpressionAttributeValues;
    if (!input.UpdateExpression) return { Item: { ...records.get(key) } };
    const claim = values[":lease"] !== undefined;
    const i = claim ? claims++ : releases++;
    const commitDelay =
      (claim ? delays.claimDelays : delays.releaseDelays)?.[i] ?? 0;
    if (commitDelay) await comparisonWait(commitDelay, abortSignal);
    const record = records.get(key) ?? {};
    if (claim) {
      if (
        (record.nextAllowedAt ?? 0) > values[":now"] ||
        (record.leaseUntil ?? 0) > values[":now"]
      )
        throw Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        });
      record.owner = values[":owner"];
      record.leaseUntil = values[":lease"];
      starts.push(Date.now());
    } else {
      if (record.owner !== values[":owner"])
        throw Object.assign(new Error("conditional"), {
          name: "ConditionalCheckFailedException",
        });
      record.nextAllowedAt = values[":next"];
      delete record.owner;
      delete record.leaseUntil;
    }
    records.set(key, record);
    const responseDelay =
      (claim ? delays.claimResponseDelays : delays.releaseResponseDelays)?.[
        i
      ] ?? 0;
    if (responseDelay) await comparisonWait(responseDelay, abortSignal);
    return {};
  });
  return {
    ddb: /** @type {import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient} */ (
      /** @type {unknown} */ ({ send })
    ),
    starts,
    send,
  };
}

/**
 * @param {ReturnType<typeof permitStore>} store
 * @param {number} [rate]
 * @returns {NonNullable<Parameters<typeof createComparisonClient>[0]["pace"]>}
 */
function pacer(store, rate = 1) {
  return createComparisonPacer({
    ddb: store.ddb,
    table: "test",
    baseUrl: "https://example.test/dev",
    requestsPerSecond: rate,
  });
}

it("paces multiple independent clients and their retries through one shared gate", async () => {
  const store = permitStore();
  /** @type {number[]} */ const fetchStarts = [];
  const clients = Array.from({ length: 8 }, () => {
    let calls = 0;
    return client(
      vi.fn(async () => {
        fetchStarts.push(Date.now());
        return ++calls === 1
          ? new Response(null, { status: 429 })
          : Response.json(body);
      }),
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
    fetchStarts.slice(1).every((start, i) => start - fetchStarts[i] >= 334),
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

it.each([100, 1300, 6500])(
  "spaces actual HTTP starts after a %sms delayed claim acknowledgement",
  async (delay) => {
    const store = permitStore({ claimResponseDelays: [delay] });
    /** @type {number[]} */ const starts = [];
    const compare = () =>
      client(
        vi.fn(async () => {
          starts.push(Date.now());
          return Response.json(body);
        }),
        { pace: pacer(store) },
      );
    const first = compare()(request);
    await vi.advanceTimersByTimeAsync(1000);
    const second = compare()(request);
    const pending = Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    if (delay > 5000) expect(store.starts.length).toBeGreaterThan(2);
  },
);

it("does not let a delayed claim commit overwrite a newer cooldown", async () => {
  const store = permitStore({ claimDelays: [1500] });
  /** @type {number[]} */ const starts = [];
  const compare = () =>
    client(
      vi.fn(async () => {
        starts.push(Date.now());
        return Response.json(body);
      }),
      { pace: pacer(store) },
    );
  const first = compare()(request);
  await vi.advanceTimersByTimeAsync(1000);
  const second = compare()(request);
  await vi.advanceTimersByTimeAsync(5000);
  await Promise.all([first, second]);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
});

it("fences an expired owner's delayed cooldown write without allowing a burst", async () => {
  const store = permitStore({ releaseDelays: [7500] });
  /** @type {number[]} */ const starts = [];
  const compare = () =>
    client(
      vi.fn(async () => {
        starts.push(Date.now());
        return Response.json(body);
      }),
      { pace: pacer(store) },
    );
  const pending = Promise.allSettled([
    compare()(request),
    compare()(request),
    compare()(request),
  ]);
  await vi.advanceTimersByTimeAsync(7501);
  const results = await pending;
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const fourth = compare()(request);
  await vi.advanceTimersByTimeAsync(3000);
  await fourth;
  expect(starts).toHaveLength(4);
  expect(starts.slice(1).every((start, i) => start - starts[i] >= 1000)).toBe(
    true,
  );
});

it("releases the start lease without waiting for the model response", async () => {
  const store = permitStore();
  /** @type {number[]} */ const starts = [];
  const compare = () =>
    client(
      vi.fn(async (_url, options) => {
        starts.push(Date.now());
        await comparisonWait(
          5000,
          /** @type {globalThis.AbortSignal} */ (options?.signal),
        );
        return Response.json(body);
      }),
      { pace: pacer(store) },
    );
  const pending = Promise.all([compare()(request), compare()(request)]);
  await vi.advanceTimersByTimeAsync(3000);
  expect(starts).toHaveLength(2);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  expect(starts[1] - starts[0]).toBeLessThan(3000);
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
});

it("never fetches when a delayed claim acknowledgement exceeds the comparison deadline", async () => {
  const store = permitStore({ claimResponseDelays: [2000] });
  const fetchImpl = vi.fn(async () => Response.json(body));
  const pending = expect(
    client(fetchImpl, { pace: pacer(store), deadlineMs: 500 })(request),
  ).rejects.toThrow("deadline");
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(fetchImpl).not.toHaveBeenCalled();
});
