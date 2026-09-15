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
      Promise.resolve({ ok: true, text: () => Promise.resolve("{}") }),
    );

    await mod.probe();
    expect(mod.getHealthState()).toBe("outage");
    await mod.probe();
    expect(mod.getHealthState()).toBe("healthy");
  });

  it("a healthy probe does NOT clear AUTH (only re-binding does)", async () => {
    const mod = await load();
    fetchMock.mockReturnValue(
      Promise.resolve({ ok: true, text: () => Promise.resolve("{}") }),
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

  it("maps ApiError 403 → AUTH (not a connectivity problem)", async () => {
    const mod = await load();
    const err = Object.assign(new Error("403"), {
      name: "ApiError",
      status: 403,
      body: { error: "forbidden" },
    });
    expect(mod.classifyApiFailure(err)).toBe("auth");
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
      Promise.resolve({ ok: true, text: () => Promise.resolve("{}") }),
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
      Promise.resolve({ ok: true, text: () => Promise.resolve("{}") }),
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
      Promise.resolve({ ok: true, text: () => Promise.resolve("{}") }),
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
    resolvers[1]("{}");
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
    resolvers[0]("{}");
    await a;
    expect(mod.getHealthState()).toBe("outage");
  });
});
