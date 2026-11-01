import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Tests for services/backend-health.js — the connection/auth state machine.
  Node environment (repo default): fetch, document, localStorage, location are
  stubbed; the module's state is reset per test via vi.resetModules +
  re-import. error-report.js is mocked so the app-event assertions don't
  depend on its enablement flag.
*/

/** @type {any} */
let fetchMock;
/** @type {Record<string, any>} */
let docListeners;

vi.mock("./error-report.js", () => ({
  reportClientEvent: vi.fn(),
}));
vi.mock("./instrument.js", () => ({
  mark: vi.fn(),
  span: vi.fn(),
}));

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  docListeners = {};
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: (/** @type {string} */ t, /** @type {any} */ fn) => {
      docListeners[t] = fn;
    },
    removeEventListener: (/** @type {string} */ t) => {
      delete docListeners[t];
    },
  });
  vi.stubGlobal("location", { pathname: "/today" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.useRealTimers();
});

/** @returns {Promise<typeof import("./backend-health.js")>} */
function load() {
  return import("./backend-health.js");
}

describe("probe + state machine", () => {
  it("stays healthy when the probe succeeds", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }),
    );

    await expect(mod.probe()).resolves.toBe("healthy");
    expect(mod.getHealthState()).toBe("healthy");
  });

  it("classifies a network failure as OUTAGE and reports it", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(Promise.reject(new Error("offline")));

    await expect(mod.probe()).resolves.toBe("outage");
    expect(mod.getHealthState()).toBe("outage");
    const { reportClientEvent } = await import("./error-report.js");
    expect(reportClientEvent).toHaveBeenCalledWith(
      "backend_unreachable",
      expect.any(String),
    );
  });

  it("classifies an HTML probe response (CDN incident shape) as OUTAGE", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve("<!doctype html><html></html>"),
      }),
    );

    await expect(mod.probe()).resolves.toBe("outage");
  });

  it("a healthy probe clears OUTAGE", async () => {
    const mod = await load();
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("x")));
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }),
    );

    await mod.probe();
    expect(mod.getHealthState()).toBe("outage");
    await mod.probe();
    expect(mod.getHealthState()).toBe("healthy");
  });

  it("a healthy probe does NOT clear AUTH (only re-binding does)", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }),
    );

    mod.classifyApiFailure(
      Object.assign(new Error("denied"), { name: "ApiError", status: 403 }),
    );
    expect(mod.getHealthState()).toBe("auth");

    await mod.probe();
    expect(mod.getHealthState()).toBe("auth");
  });

  it("clearAuthState returns everything to healthy", async () => {
    const mod = await load();
    mod.classifyApiFailure(
      Object.assign(new Error("reauth"), { name: "ReauthRequiredError" }),
    );
    expect(mod.getHealthState()).toBe("auth");

    mod.clearAuthState();
    expect(mod.getHealthState()).toBe("healthy");
  });
});

describe("classifyApiFailure", () => {
  it("maps ReauthRequiredError → AUTH", async () => {
    const mod = await load();
    const err = Object.assign(new Error("reauth"), {
      name: "ReauthRequiredError",
    });
    expect(mod.classifyApiFailure(err)).toBe("auth");
  });

  it("maps missing manager access to ACCESS", async () => {
    const mod = await load();
    const err = Object.assign(new Error("403"), {
      name: "ApiError",
      status: 403,
      body: { error: "manager_access_required" },
    });
    expect(mod.classifyApiFailure(err)).toBe("access");
  });

  it.each(["Update belongs to another session", "forbidden"])(
    "leaves unrelated permission denial %s to the action UI",
    async (code) => {
      const mod = await load();
      const listener = vi.fn();
      const unsubscribe = mod.onHealthChange(listener);
      const error = Object.assign(new Error("403"), {
        name: "ApiError",
        status: 403,
        body: { error: code },
      });
      expect(mod.classifyApiFailure(error)).toBe("healthy");
      expect(listener).not.toHaveBeenCalled();
      mod.classifyApiFailure(
        Object.assign(new Error("expired"), { name: "ReauthRequiredError" }),
      );
      expect(mod.classifyApiFailure(error)).toBe("auth");
      unsubscribe();
    },
  );

  it("still treats a bare gateway denial as a rejected session", async () => {
    const mod = await load();
    expect(
      mod.classifyApiFailure(
        Object.assign(new Error("403"), {
          name: "ApiError",
          status: 403,
          body: { message: "Forbidden" },
        }),
      ),
    ).toBe("auth");
  });

  it("dismisses missing manager enrollment without treating the session as expired", async () => {
    const mod = await load();
    const err = Object.assign(new Error("denied"), {
      name: "ApiError",
      status: 403,
      body: { error: "manager_access_required" },
    });
    expect(mod.classifyApiFailure(err)).toBe("access");
    mod.clearAccessState();
    expect(mod.getHealthState()).toBe("healthy");
    mod.classifyApiFailure(
      Object.assign(new Error("expired"), { name: "ReauthRequiredError" }),
    );
    mod.classifyApiFailure(err);
    mod.clearAccessState();
    expect(mod.getHealthState()).toBe("auth");
  });

  it("maps transport failure (status 0) → OUTAGE", async () => {
    const mod = await load();
    const err = Object.assign(new Error("net"), {
      name: "ApiError",
      status: 0,
    });
    expect(mod.classifyApiFailure(err)).toBe("outage");
  });

  it("maps non_json_response (any status) → OUTAGE and probes immediately", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }),
    );
    const err = Object.assign(new Error("html"), {
      name: "ApiError",
      status: 200,
      body: { code: "non_json_response" },
    });
    expect(mod.classifyApiFailure(err)).toBe("outage");
    // The immediate probe ran (fetch called for /health).
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/health", expect.anything()),
    );
  });

  it("maps a non-JSON 403 (intermediary rewrite) → OUTAGE, never AUTH", async () => {
    // An HTML 403 from a CDN is a transport failure, not an auth verdict —
    // it must never trigger the destructive sign-out recovery.
    const mod = await load();
    const err = Object.assign(new Error("html 403"), {
      name: "ApiError",
      status: 403,
      body: { code: "non_json_response" },
    });
    expect(mod.classifyApiFailure(err)).toBe("outage");
    expect(mod.getHealthState()).toBe("outage");
  });

  it("ignores ordinary 4xx/5xx (not connection-wide)", async () => {
    const mod = await load();
    const err = Object.assign(new Error("404"), {
      name: "ApiError",
      status: 404,
      body: { error: "Check not found" },
    });
    expect(mod.classifyApiFailure(err)).toBe("healthy");
  });
});

describe("monitoring wiring", () => {
  it("re-probes on visibilitychange when returning to the app", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }),
    );

    mod.startHealthMonitoring();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    docListeners.visibilitychange();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    mod.stopHealthMonitoring();
  });

  it("does not re-probe while hidden", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve('{"ok":true}') }),
    );

    mod.startHealthMonitoring();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // The stub is a plain object, but its declared shape is Document — cast
    // to flip `hidden` (a read-only property on the real interface).
    /** @type {any} */ (document).hidden = true;
    docListeners.visibilitychange();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no probe while hidden

    mod.stopHealthMonitoring();
  });
});

describe("subscriber notification", () => {
  it("notifies listeners on state transitions", async () => {
    const mod = await load();
    /** @type {string[]} */
    const seen = [];
    const unsubscribe = mod.onHealthChange((/** @type {any} */ s) =>
      seen.push(s),
    );
    fetchMock.mockReturnValueOnce(Promise.reject(new Error("x")));

    await mod.probe();
    unsubscribe();

    expect(seen).toEqual(["outage"]);
  });
});

describe("retry backoff (fixes 7 + 8)", () => {
  it("advances the backoff ladder across repeated failures (not stuck at 30s)", async () => {
    vi.useFakeTimers();
    const mod = await load();
    // Every probe fails.
    fetchMock.mockReturnValue(Promise.reject(new Error("down")));

    await mod.probe();
    // First failure → first retry scheduled at 30s.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1); // not yet
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 30s retry ran

    // Second failure → retry at 60s (the ladder advanced; the pre-fix code
    // reset backoffIndex inside probe(), polling forever at 30s).
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 60s retry ran

    mod.stopHealthMonitoring();
  });

  it("stopHealthMonitoring kills the live retry chain (no post-teardown fetches)", async () => {
    vi.useFakeTimers();
    const mod = await load();
    fetchMock.mockReturnValue(Promise.reject(new Error("x")));

    await mod.probe(); // schedules a 30s retry
    mod.stopHealthMonitoring();

    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // chain dead
  });

  it("a new schedule replaces a pending retry timer (one live chain)", async () => {
    vi.useFakeTimers();
    const mod = await load();
    fetchMock.mockReturnValue(Promise.reject(new Error("x")));

    await mod.probe(); // schedules retry #1 (30s; index → 1)
    // A visibility-triggered probe fires before retry #1: it also fails and
    // REPLACES the pending timer with the next ladder step (60s; index → 2)
    // — one live chain, not two.
    await mod.probe();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // replacement not yet (60s)
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 2 probes + the 60s retry
    mod.stopHealthMonitoring();
  });
});

describe("concurrent probes (fix 9 — generation guard)", () => {
  it("a stale failed probe cannot clobber a newer healthy result", async () => {
    const mod = await load();
    /** @type {Array<(body: string, ok?: boolean) => void>} */
    const resolvers = [];
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push((body, ok = true) =>
            // @ts-ignore test shape
            resolve({ ok, text: () => Promise.resolve(body) }),
          );
        }),
    );

    // Probe A (slow) starts; probe B (fast) starts and succeeds first.
    const a = mod.probe();
    const b = mod.probe();
    // B completes healthy.
    await Promise.resolve();
    resolvers[1]('{"ok":true}');
    await b;
    expect(mod.getHealthState()).toBe("healthy");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A completes as a failure LATER — it is stale and must not restore
    // outage (which would re-show the banner and schedule more retries).
    resolvers[0]("<html></html>");
    await a;
    expect(mod.getHealthState()).toBe("healthy");
  });

  it("a newer failed probe after a stale success still records the outage", async () => {
    const mod = await load();
    /** @type {Array<(body: string, ok?: boolean) => void>} */
    const resolvers = [];
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push((body, ok = true) =>
            // @ts-ignore test shape
            resolve({ ok, text: () => Promise.resolve(body) }),
          );
        }),
    );

    const a = mod.probe();
    const b = mod.probe();
    // B fails first (recent): outage.
    resolvers[1]("<html></html>", false);
    await b;
    expect(mod.getHealthState()).toBe("outage");

    // A (stale) completes healthy — it must NOT clear the newer outage.
    resolvers[0]('{"ok":true}');
    await a;
    expect(mod.getHealthState()).toBe("outage");
  });
});

describe("shared reachability", () => {
  it("keeps auth independent while the banner tracks transport recovery", async () => {
    const mod = await load();
    const changes = vi.fn();
    mod.onConnectionChange(changes);
    mod.classifyApiFailure(
      Object.assign(new Error("expired"), { name: "ReauthRequiredError" }),
    );
    mod.connectionFailed("api:test", "/health");
    expect(mod.getHealthState()).toBe("auth");
    expect(mod.connectionSnapshot().disconnected).toBe(true);
    mod.clearAuthState();
    expect(mod.getHealthState()).toBe("outage");
    fetchMock.mockResolvedValue(new Response('{"ok":true}'));
    await mod.retryConnection();
    expect(mod.getHealthState()).toBe("healthy");
    expect(changes).toHaveBeenLastCalledWith({ disconnected: false });
  });

  it("does not announce recovery for an HTML API response", async () => {
    const mod = await load();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    mod.connectionFailed("api:http://localhost", "http://localhost/health");
    fetchMock.mockResolvedValue(new Response("<html>CDN fallback</html>"));
    await mod.connectionFetch("http://localhost/v1/tasks");
    expect(mod.getHealthState()).toBe("outage");
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("uses one recovery event when the boot probe clears an outage", async () => {
    const mod = await load();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    mod.connectionFailed("api:http://localhost", "http://localhost/health");
    fetchMock.mockResolvedValue(new Response('{"ok":true}'));
    await mod.probe();
    expect(mod.getHealthState()).toBe("healthy");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});

it("shares Retry-After between recovery and visibility probes", async () => {
  const mod = await load();
  mod.connectionFailed("api:http://localhost", "http://localhost/health");
  fetchMock.mockResolvedValue(
    new Response(null, { status: 429, headers: { "Retry-After": "300" } }),
  );
  await mod.retryConnection();
  await mod.probe();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(mod.getHealthState()).toBe("outage");
  mod.stopHealthMonitoring();
});

it("does not start retry timers before monitoring is requested", async () => {
  vi.useFakeTimers();
  const mod = await load();
  mod.connectionFailed("api:test", "/health");
  expect(mod.getHealthState()).toBe("outage");
  expect(vi.getTimerCount()).toBe(0);
  fetchMock.mockRejectedValue(new TypeError("offline"));
  await mod.probe();
  expect(vi.getTimerCount()).toBe(1);
  mod.stopHealthMonitoring();
  expect(vi.getTimerCount()).toBe(0);
});

describe("shared probe ordering", () => {
  it.each(["http", "network"])(
    "ignores an older %s failure after retry recovery",
    async (kind) => {
      vi.useFakeTimers();
      const mod = await load();
      const dispatchEvent = vi.fn();
      vi.stubGlobal("window", { dispatchEvent });
      let finish = () => {};
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              kind === "network"
                ? reject(new TypeError("offline"))
                : resolve(new Response("down", { status: 503 }));
          }),
      );
      mod.connectionFailed("api:http://localhost", "http://localhost/health");
      const old = mod.probe();
      fetchMock.mockResolvedValue(new Response('{"ok":true}'));
      await mod.retryConnection();
      expect(mod.getHealthState()).toBe("healthy");
      finish();
      await old;
      expect(mod.getHealthState()).toBe("healthy");
      expect(mod.connectionSnapshot().disconnected).toBe(false);
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      mod.stopHealthMonitoring();
    },
  );

  it("ignores an old retry body after a newer visibility probe fails", async () => {
    const mod = await load();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    /** @type {(body: string) => void} */
    let finish = () => {};
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    mod.connectionFailed("api:http://localhost", "http://localhost/health");
    fetchMock.mockResolvedValueOnce({ ok: true, text: () => body });
    const old = mod.retryConnection();
    await Promise.resolve();
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    await mod.probe();
    finish('{"ok":true}');
    await old;
    expect(mod.getHealthState()).toBe("outage");
    expect(dispatchEvent).not.toHaveBeenCalled();
    mod.stopHealthMonitoring();
  });
});

it("does not classify a throttled non-JSON API response as auth or outage", async () => {
  const mod = await load();
  expect(
    mod.classifyApiFailure(
      Object.assign(new Error("limited"), {
        name: "ApiError",
        status: 429,
        body: { code: "non_json_response" },
      }),
    ),
  ).toBe("healthy");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps health state and delays probes through a 429 cooldown", async () => {
  vi.useFakeTimers();
  const mod = await load();
  fetchMock
    .mockResolvedValueOnce(
      new Response("<html>Limited</html>", {
        status: 429,
        headers: { "Retry-After": "300" },
      }),
    )
    .mockResolvedValue(new Response('{"ok":true}'));
  try {
    expect(await mod.probe()).toBe("healthy");
    await vi.advanceTimersByTimeAsync(15000);
    expect(await mod.probe()).toBe("healthy");
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(284999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mod.getHealthState()).toBe("healthy");
  } finally {
    mod.stopHealthMonitoring();
  }
});

it("does not announce an outage for a throttled HTML API response", async () => {
  const mod = await load();
  fetchMock.mockResolvedValue(
    new Response("<html>Limited</html>", { status: 429 }),
  );
  const response = await mod.connectionFetch("http://localhost/v1/tasks");
  expect(response.status).toBe(429);
  expect(mod.getHealthState()).toBe("healthy");
  expect(mod.connectionSnapshot().disconnected).toBe(false);
});

it.each([403, 413, 429])(
  "admin HTML rejection %s remains reachable",
  async (status) => {
    const mod = await load();
    fetchMock.mockResolvedValue(
      new Response("<html>Rejected</html>", { status }),
    );
    const response = await mod.connectionFetch(
      "http://localhost/admin/v1/site-imports/preview",
      {},
      {
        httpRejectionsAreReachable: true,
      },
    );
    expect(response.status).toBe(status);
    expect(mod.connectionSnapshot().disconnected).toBe(false);
  },
);

it.each([200, 502, 504])(
  "admin HTML response %s still signals an outage",
  async (status) => {
    const mod = await load();
    fetchMock.mockResolvedValue(
      new Response("<html>CDN error</html>", { status }),
    );
    await mod.connectionFetch(
      "http://localhost/admin/v1/site-imports/preview",
      {},
      {
        httpRejectionsAreReachable: true,
      },
    );
    expect(mod.connectionSnapshot().disconnected).toBe(true);
  },
);

it("admin network failures still signal an outage", async () => {
  const mod = await load();
  fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
  await expect(
    mod.connectionFetch(
      "http://localhost/admin/v1/site-imports/preview",
      {},
      {
        httpRejectionsAreReachable: true,
      },
    ),
  ).rejects.toThrow(TypeError);
  expect(mod.connectionSnapshot().disconnected).toBe(true);
});

it("preserves default HTML 403 classification for the app", async () => {
  const mod = await load();
  fetchMock.mockResolvedValue(
    new Response("<html>Rejected</html>", { status: 403 }),
  );
  await mod.connectionFetch("http://localhost/v1/tasks");
  expect(mod.connectionSnapshot().disconnected).toBe(true);
});
