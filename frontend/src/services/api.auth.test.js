import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ReauthRequiredError } from "./api.js";
import { updateSiteSession, prepareRefreshAttempt } from "../db.js";

/*
  Auth-flow tests for the device-token plumbing (Option 4, docs/adr/0010).
  Every fetch here is stubbed; db.js is mocked in-memory so each test controls
  what "the stored site record" holds and what refreshes persisted.
*/

/** The stored site record the mocked db.js returns/persists. */
let site;

/**
 * @param {Array<{ status: number, body?: any } | { reject: Error }>} list
 */
function stubFetch(list) {
  let i = 0;
  return vi.fn((...args) => {
    void args;
    const r = list[Math.min(i, list.length - 1)];
    i += 1;
    if ("reject" in r) return Promise.reject(r.reject);
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 401 ? "Unauthorized" : "Status",
      text: () => Promise.resolve(JSON.stringify(r.body ?? {})),
    });
  });
}

vi.mock("../db.js", () => ({
  getSite: vi.fn(() => Promise.resolve(site)),
  prepareRefreshAttempt: vi.fn(async (siteId, refreshToken) => {
    if (site?.siteId !== siteId || site.refreshToken !== refreshToken)
      return null;
    if (site.refreshAttempt?.refreshToken !== refreshToken)
      site.refreshAttempt = {
        id: crypto.randomUUID(),
        refreshToken,
      };
    return site.refreshAttempt.id;
  }),
  updateSiteSession: vi.fn((session, expectedSiteId, expectedRefreshToken) => {
    if (
      site.siteId !== expectedSiteId ||
      (expectedRefreshToken && site.refreshToken !== expectedRefreshToken)
    )
      return Promise.resolve(null);
    // Mirror the real merge: token fields replace, identity stays.
    site = { ...site, ...session };
    delete site.refreshAttempt;
    return Promise.resolve(site);
  }),
}));

// instrument.js is real (harmless under test), refreshDeviceToken is mocked:
// its own contract is covered by devices.test.js.
vi.mock("./devices.js", () => ({
  refreshDeviceToken: vi.fn(),
}));

import { refreshDeviceToken } from "./devices.js";
import { completeTask, getCaptureGuidance, listChecks } from "./api.js";

/** A valid session the refresh endpoint would mint. */
const freshSession = {
  deviceId: "dev_1",
  site: { siteId: "site_1", name: "Site" },
  token: "access-2",
  refreshToken: "refresh-2",
  expiresIn: 100,
  refreshExpiresIn: 200,
  tokenGeneration: 2,
};

beforeEach(() => {
  site = {
    id: "current",
    siteId: "site_1",
    name: "Site",
    deviceId: "dev_1",
    token: "access-1",
    refreshToken: "refresh-1",
    tokenGeneration: 1,
  };
  vi.mocked(refreshDeviceToken).mockReset();
  vi.mocked(refreshDeviceToken).mockImplementation(async () => freshSession);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request auth flow (listChecks as the vehicle)", () => {
  it("silently refreshes once on a 401 and retries with the new token", async () => {
    const fetch = stubFetch([
      { status: 401 },
      { status: 200, body: { checks: [] } },
    ]);
    vi.stubGlobal("fetch", fetch);

    await expect(listChecks()).resolves.toMatchObject({ checks: [] });
    expect(refreshDeviceToken).toHaveBeenCalledWith(
      "refresh-1",
      expect.any(String),
    );
    expect(updateSiteSession).toHaveBeenCalledWith(
      freshSession,
      "site_1",
      "refresh-1",
    );
    // Retry leg rode the persisted access token.
    expect(fetch).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer access-2",
        }),
      }),
    );
  });

  it("silently refreshes an API Gateway authorizer 403", async () => {
    const fetch = stubFetch([
      { status: 403, body: { message: "Forbidden" } },
      { status: 200, body: { checks: [] } },
    ]);
    vi.stubGlobal("fetch", fetch);

    await expect(listChecks()).resolves.toMatchObject({ checks: [] });
    expect(refreshDeviceToken).toHaveBeenCalledWith(
      "refresh-1",
      expect.any(String),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not refresh an application-level 403", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([{ status: 403, body: { error: "admin_access_required" } }]),
    );

    await expect(listChecks()).rejects.toMatchObject({
      status: 403,
      body: { error: "admin_access_required" },
    });
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps a rejected refresh (401) to ReauthRequiredError", async () => {
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    vi.mocked(refreshDeviceToken).mockRejectedValue(
      new ApiError("refresh rejected", { status: 401 }),
    );

    await expect(listChecks()).rejects.toBeInstanceOf(ReauthRequiredError);
  });

  it("does not refresh or retry a late 401 after switching sites", async () => {
    let releaseResponse = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            releaseResponse = () =>
              resolve({
                ok: false,
                status: 401,
                statusText: "Unauthorized",
                text: () => Promise.resolve("{}"),
              });
          }),
      ),
    );

    const pending = completeTask("task-1", { completionMethod: "on_site" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch).toHaveBeenCalledWith(
      "/v1/tasks/task-1/complete",
      expect.objectContaining({ method: "POST" }),
    );
    site = {
      ...site,
      siteId: "site_2",
      token: "site-2-access",
      refreshToken: "site-2-refresh",
    };
    releaseResponse();

    await expect(pending).rejects.toMatchObject({
      name: "SiteBindingChangedError",
    });
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not persist a refresh that completes after switching sites", async () => {
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    let releaseRefresh = () => {};
    vi.mocked(refreshDeviceToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRefresh = () => resolve(freshSession);
        }),
    );

    const pending = listChecks();
    await vi.waitFor(() => expect(refreshDeviceToken).toHaveBeenCalledTimes(1));
    site = {
      ...site,
      siteId: "site_2",
      token: "site-2-access",
      refreshToken: "site-2-refresh",
    };
    releaseRefresh();

    await expect(pending).rejects.toMatchObject({
      name: "SiteBindingChangedError",
    });
    expect(site.token).toBe("site-2-access");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not require reauthentication for a previous site's late refresh rejection", async () => {
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    let rejectRefresh = () => {};
    vi.mocked(refreshDeviceToken).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRefresh = () =>
            reject(new ApiError("old token revoked", { status: 401 }));
        }),
    );

    const pending = listChecks();
    await vi.waitFor(() => expect(refreshDeviceToken).toHaveBeenCalledTimes(1));
    site = {
      ...site,
      siteId: "site_2",
      token: "site-2-access",
      refreshToken: "site-2-refresh",
    };
    rejectRefresh();

    const error = await pending.catch((caught) => caught);
    expect(error.name).toBe("SiteBindingChangedError");
    expect(error).not.toBeInstanceOf(ReauthRequiredError);
  });

  it("surfaces a retryable refresh failure (5xx) as-is, not ReauthRequiredError", async () => {
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    vi.mocked(refreshDeviceToken).mockRejectedValue(
      new ApiError("boom", { status: 503 }),
    );

    const err = await listChecks().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err).not.toBeInstanceOf(ReauthRequiredError);
  });

  it("surfaces a transport failure during refresh as-is (status 0)", async () => {
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    vi.mocked(refreshDeviceToken).mockRejectedValue(
      new ApiError("offline", { status: 0 }),
    );

    const err = await listChecks().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err).not.toBeInstanceOf(ReauthRequiredError);
  });

  it("maps a second 401 on the retry leg to ReauthRequiredError", async () => {
    // Both legs rejected: the freshly minted access token is dead too.
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }, { status: 401 }]));

    await expect(listChecks()).rejects.toBeInstanceOf(ReauthRequiredError);
    // One refresh only — the retry leg never re-arms the auth path.
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
  });

  it("maps a second authorizer 403 on the retry leg to ReauthRequiredError", async () => {
    vi.stubGlobal(
      "fetch",
      stubFetch([
        { status: 403, body: { message: "Forbidden" } },
        { status: 403, body: { message: "Forbidden" } },
      ]),
    );

    await expect(listChecks()).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
  });

  it("shares ONE refresh across concurrent 401s", async () => {
    // Each fetch resolves on its own macrotask so both 401s land while the
    // first refresh is still in flight.
    let inFlight = 0;
    let maxInFlight = 0;
    /** @param {{ status: number }} r */
    const slowish = (r) => () =>
      new Promise((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            statusText: "S",
            text: () => Promise.resolve(JSON.stringify({})),
          });
        }, 5);
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => slowish({ status: 401 })()),
    );
    vi.mocked(refreshDeviceToken).mockImplementation(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(freshSession), 20)),
    );

    const [a, b] = await Promise.allSettled([listChecks(), listChecks()]);
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
    expect(a.status).toBe("rejected"); // both retry legs 401 again
    expect(b.status).toBe("rejected");
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("a 401 arriving AFTER a completed refresh uses the CURRENT stored refresh token, not a stale replay", async () => {
    // Issue-#3 interleaving: R1's API fetch reads the site (access-1) and is
    // HELD; meanwhile R2 401s, rotates refresh-1 → refresh-2 (persisted via
    // updateSiteSession), and the in-flight slot CLEARS. Only then does R1's
    // 401 land — its refresh leg must re-read the stored record (refresh-2),
    // not replay the dead refresh-1.
    let releaseR1 = () => {};
    const r1Gate = new Promise((resolve) => {
      releaseR1 = () => resolve(undefined);
    });

    let r1Fired = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!r1Fired) {
          r1Fired = true;
          await r1Gate; // hold R1's API response
          return {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: () => Promise.resolve("{}"),
          };
        }
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("{}"),
        };
      }),
    );
    // Fresh session per refresh, as the real endpoint would mint; the mocked
    // updateSiteSession persists it exactly like the real db layer.
    vi.mocked(refreshDeviceToken).mockResolvedValue(freshSession);

    const r1 = listChecks();
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const r2 = listChecks();
    // Subscribe immediately so R2's expected rejection isn't unhandled while
    // we wait below.
    const settled = Promise.allSettled([r1, r2]);
    // R2: 401 → full refresh-1 rotation, persisted, in-flight slot cleared.
    await vi.waitFor(() => {
      expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
      expect(site.refreshToken).toBe("refresh-2");
    });
    // Release R1's held 401 — its refresh leg starts only now, after the
    // rotation completed and cleared.
    releaseR1();
    await settled;

    // R1 reuses the persisted access token from R2 instead of rotating again.
    const tokens = vi.mocked(refreshDeviceToken).mock.calls.map((c) => c[0]);
    expect(tokens).toEqual(["refresh-1"]);
  });

  it("does not poison the shared promise: a rejected refresh clears, the next request refreshes again", async () => {
    // R1: refresh rejected (fatal). R2 (later): refresh succeeds now.
    vi.stubGlobal(
      "fetch",
      stubFetch([
        { status: 401 },
        { status: 401 },
        { status: 200, body: { checks: [] } },
      ]),
    );
    vi.mocked(refreshDeviceToken)
      .mockRejectedValueOnce(new ApiError("rejected", { status: 401 }))
      .mockResolvedValueOnce(freshSession);

    await expect(listChecks()).rejects.toBeInstanceOf(ReauthRequiredError);
    await expect(listChecks()).resolves.toMatchObject({ checks: [] });
    expect(refreshDeviceToken).toHaveBeenCalledTimes(2);
  });

  it("a second-leg 401 after ANOTHER rotation superseded the token is a lost race, not ReauthRequiredError", async () => {
    // R1 401s → refresh (rotation 1: access-2 persisted) → retryToken is
    // captured (access-2) → retry in flight. DURING the retry, R2's late 401
    // rotates AGAIN (rotation 2: access-3 persisted) — bumping
    // tokenGeneration and instantly invalidating access-2. R1's retry then
    // 401s, but the stored session (access-3) is NEWER than the one R1 rode,
    // so the session is alive: a plain 401, not the global
    // ReauthRequiredError that would lock the app.
    /** @type {Array<(value?: unknown) => void>} */
    const gates = [];
    let retries = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        retries += 1;
        if (retries === 1) {
          // Leg 1: 401 (triggers rotation 1).
          return {
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: () => Promise.resolve("{}"),
          };
        }
        // Retry leg: hold mid-flight until rotation 2 has landed.
        await new Promise((resolve) => gates.push(resolve));
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("{}"),
        };
      }),
    );

    /** @type {number} */
    let rotations = 0;
    vi.mocked(refreshDeviceToken).mockImplementation(async () => {
      rotations += 1;
      if (rotations === 1) {
        // Rotation 1: R1's refresh → access-2 (persisted by the
        // updateSiteSession mock). The in-flight slot clears in finally.
        await new Promise((r) => setTimeout(r, 0));
        return freshSession;
      }
      // Rotation 2 (R2's concurrent late refresh): persist access-3.
      const newer = {
        ...freshSession,
        token: "access-3",
        refreshToken: "refresh-3",
      };
      site = { ...site, ...newer };
      return newer;
    });

    const pending = listChecks();
    // Wait until the retry leg is in flight (retryToken already captured),
    // then fire R2's late refresh (rotation 2) against the cleared slot.
    await vi.waitFor(() => expect(retries).toBe(2));
    await new Promise((r) => setTimeout(r, 0));
    await refreshDeviceToken("refresh-1"); // R2's late 401 → rotation 2 (access-3)
    // Now release the retry leg so its 401 lands AFTER rotation 2 persisted.
    for (const g of gates) g();
    const err = await pending.catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err).not.toBeInstanceOf(ReauthRequiredError);
    expect(site.token).toBe("access-3"); // latest session intact
  });
});

/** Assert the Nth fetch (1-based) carried the given bearer token. */
function expectNthFetchBearer(fetch, n, token) {
  expect(fetch).toHaveBeenNthCalledWith(
    n,
    expect.anything(),
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: `Bearer ${token}` }),
    }),
  );
}

describe("pre-flight refresh on a known-expiring token", () => {
  const ok = { status: 200, body: { checks: [] } };

  it("refreshes before the first fetch when the stored token is expired", async () => {
    site.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await listChecks();
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expectNthFetchBearer(fetch, 1, "access-2");
  });

  it("refreshes inside the margin and accepts an epoch-millisecond expiry", async () => {
    site.tokenExpiresAt = Date.now() + 30_000;
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await listChecks();
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
    expectNthFetchBearer(fetch, 1, "access-2");
  });

  it("sends the stored token untouched when it is not near expiry", async () => {
    site.tokenExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await listChecks();
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expectNthFetchBearer(fetch, 1, "access-1");
  });

  it("sends the stored token when the expiry is unknown or unreadable", async () => {
    site.tokenExpiresAt = "not a date";
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await listChecks();
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expectNthFetchBearer(fetch, 1, "access-1");
  });

  it("collapses parallel requests into one refresh", async () => {
    site.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await Promise.all([listChecks(), listChecks(), listChecks()]);
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const n of [1, 2, 3]) expectNthFetchBearer(fetch, n, "access-2");
  });

  it("falls back to the stored token when the refresh endpoint is down", async () => {
    site.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    vi.mocked(refreshDeviceToken).mockRejectedValueOnce(
      new ApiError("POST /device/refresh → 503", { status: 503 }),
    );
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await listChecks();
    expect(fetch).toHaveBeenCalledTimes(1);
    expectNthFetchBearer(fetch, 1, "access-1");
  });

  it("makes exactly one refresh attempt when the expired token is then rejected", async () => {
    site.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    const outage = new ApiError("POST /device/refresh → 503", { status: 503 });
    vi.mocked(refreshDeviceToken).mockRejectedValue(outage);
    const fetch = stubFetch([{ status: 403, body: { message: "Forbidden" } }]);
    vi.stubGlobal("fetch", fetch);
    await expect(listChecks()).rejects.toBe(outage);
    expect(refreshDeviceToken).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops waiting on a pending refresh when the caller aborts", async () => {
    site.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    let releaseRefresh = () => {};
    vi.mocked(refreshDeviceToken).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRefresh = () => resolve(freshSession);
        }),
    );
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const pending = getCaptureGuidance({
      startedAt: "2026-10-20T00:00:00.000Z",
      checkId: "chk_1",
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
    // The shared refresh still completes and persists for other callers.
    releaseRefresh();
    await vi.waitFor(() => expect(site.token).toBe("access-2"));
  });

  it("is fatal when the refresh is rejected outright", async () => {
    site.tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
    vi.mocked(refreshDeviceToken).mockRejectedValueOnce(
      new ApiError("POST /device/refresh → 401", { status: 401 }),
    );
    const fetch = stubFetch([ok]);
    vi.stubGlobal("fetch", fetch);
    await expect(listChecks()).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("uncertain manual completion", () => {
  it("reconciles a lost response and replays only a confirmed same-method completion", async () => {
    const fetch = stubFetch([
      { reject: new TypeError("connection lost") },
      {
        status: 200,
        body: { task: { status: "completed", completionMethod: "manual" } },
      },
      {
        status: 200,
        body: { task: { status: "completed" }, resultsPending: true },
      },
    ]);
    vi.stubGlobal("fetch", fetch);
    await expect(
      completeTask("task", { completionMethod: "manual" }),
    ).resolves.toMatchObject({ resultsPending: true });
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual([
      "POST",
      "GET",
      "POST",
    ]);
  });

  it.each(["open", "superseded", "deleted"])(
    "does not replay an uncertain save when task is %s",
    async (status) => {
      const fetch = stubFetch([
        { status: 500 },
        { status: 200, body: { task: { status, completionMethod: "manual" } } },
      ]);
      vi.stubGlobal("fetch", fetch);
      await expect(
        completeTask("task", { completionMethod: "manual" }),
      ).rejects.toMatchObject({ status: 500 });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it("does not claim a completion performed with a different method", async () => {
    const fetch = stubFetch([
      { status: 409 },
      {
        status: 200,
        body: { task: { status: "completed", completionMethod: "311_filed" } },
      },
    ]);
    vi.stubGlobal("fetch", fetch);
    await expect(
      completeTask("task", { completionMethod: "manual" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("polls an overlapping completion with a bounded wait", async () => {
    vi.useFakeTimers();
    try {
      const fetch = stubFetch([
        { status: 409 },
        { status: 200, body: { task: { status: "completing" } } },
      ]);
      vi.stubGlobal("fetch", fetch);
      const result = expect(
        completeTask("task", { completionMethod: "manual" }),
      ).rejects.toMatchObject({ status: 409 });
      await vi.runAllTimersAsync();
      await result;
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconcile explicit City submissions", async () => {
    const fetch = stubFetch([{ status: 500 }]);
    vi.stubGlobal("fetch", fetch);
    await expect(
      completeTask("task", { completionMethod: "311_filed" }),
    ).rejects.toMatchObject({ status: 500 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it("keeps reconciliation bound to the site where the action started", async () => {
  const fetch = vi.fn(async () => {
    site = { ...site, siteId: "different-site" };
    throw new TypeError("connection lost after saving");
  });
  vi.stubGlobal("fetch", fetch);
  await expect(
    completeTask("task", { completionMethod: "manual" }),
  ).rejects.toBeInstanceOf(ApiError);
  expect(fetch).toHaveBeenCalledOnce();
});

it("recovers an overlapping completion once the matching result is confirmed", async () => {
  vi.useFakeTimers();
  try {
    const fetch = stubFetch([
      { status: 409 },
      { status: 200, body: { task: { status: "completing" } } },
      {
        status: 200,
        body: { task: { status: "completed", completionMethod: "manual" } },
      },
      {
        status: 200,
        body: { task: { status: "completed" }, resultsPending: false },
      },
    ]);
    vi.stubGlobal("fetch", fetch);
    const result = completeTask("task", { completionMethod: "manual" });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ resultsPending: false });
    expect(fetch.mock.calls.map((call) => call[1].method)).toEqual([
      "POST",
      "GET",
      "GET",
      "POST",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

describe("durable refresh recovery attempts", () => {
  for (const status of [0, 409, 503]) {
    it(`retains and reuses the attempt after a retryable ${status} failure`, async () => {
      site.tokenExpiresAt = "2000-01-01T00:00:00Z";
      vi.stubGlobal(
        "fetch",
        stubFetch([{ status: 401 }, { status: 200, body: { checks: [] } }]),
      );
      vi.mocked(refreshDeviceToken)
        .mockRejectedValueOnce(new ApiError("interrupted", { status }))
        .mockResolvedValue(freshSession);
      await expect(listChecks()).rejects.toMatchObject({ status });
      const attempt = site.refreshAttempt.id;
      expect(site.refreshToken).toBe("refresh-1");
      await expect(listChecks()).resolves.toMatchObject({ checks: [] });
      expect(
        vi.mocked(refreshDeviceToken).mock.calls.map((call) => call[1]),
      ).toEqual([attempt, attempt]);
      expect(site.refreshAttempt).toBeUndefined();
      expect(site.refreshToken).toBe(freshSession.refreshToken);
    });
  }
  it("commits the attempt before sending refresh and never sends after local persistence fails", async () => {
    site.tokenExpiresAt = "2000-01-01T00:00:00Z";
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    vi.mocked(prepareRefreshAttempt).mockRejectedValueOnce(
      new DOMException("Storage full", "QuotaExceededError"),
    );
    await expect(listChecks()).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expect(site.refreshToken).toBe("refresh-1");
  });
  it("does not overwrite a new enrollment at the same Site after a late response", async () => {
    site.tokenExpiresAt = "2000-01-01T00:00:00Z";
    vi.mocked(refreshDeviceToken).mockImplementationOnce(async () => {
      site = {
        ...site,
        deviceId: "replacement",
        token: "replacement-token",
        refreshToken: "replacement-refresh",
      };
      return freshSession;
    });
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    await expect(listChecks()).rejects.toMatchObject({
      name: "SiteBindingChangedError",
    });
    expect(site.refreshToken).toBe("replacement-refresh");
    expect(site.deviceId).toBe("replacement");
  });
});

describe("refresh remains bound to its original enrollment", () => {
  it("does not retry an old request with replacement credentials after a failed refresh", async () => {
    site.tokenExpiresAt = "2000-01-01T00:00:00Z";
    vi.mocked(refreshDeviceToken).mockImplementationOnce(async () => {
      site = {
        ...site,
        deviceId: "replacement",
        localSessionId: "new-enrollment",
        token: "new-access",
        refreshToken: "new-refresh",
      };
      throw new ApiError("lost response", { status: 0 });
    });
    const fetch = stubFetch([{ status: 200, body: { checks: [] } }]);
    vi.stubGlobal("fetch", fetch);
    await expect(listChecks()).rejects.toMatchObject({
      name: "SiteBindingChangedError",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(site.refreshToken).toBe("new-refresh");
  });
  it("rejects an old request if enrollment changes while it waits for the refresh lock", async () => {
    site.tokenExpiresAt = "2000-01-01T00:00:00Z";
    /** @type {() => void} */
    let release = () => {
      throw new Error("Refresh lock was not acquired");
    };
    let reached;
    const held = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const queued = new Promise((resolve) => {
      reached = resolve;
    });
    vi.stubGlobal("navigator", {
      locks: {
        request: vi.fn(async (_name, work) => {
          reached();
          await held;
          return work();
        }),
      },
    });
    const fetch = stubFetch([{ status: 200, body: { checks: [] } }]);
    vi.stubGlobal("fetch", fetch);
    const request = listChecks();
    const rejected = expect(request).rejects.toMatchObject({
      name: "SiteBindingChangedError",
    });
    await queued;
    site = {
      ...site,
      localSessionId: "new-enrollment",
      token: "new-access",
      refreshToken: "new-refresh",
    };
    release();
    await rejected;
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.each(["json", "html", "empty"])(
  "keeps a %s 429 as throttling without refreshing or changing health",
  async (bodyKind) => {
    const { getHealthState } = await import("./backend-health.js");
    const before = getHealthState();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          bodyKind === "html"
            ? "<html>Too many requests</html>"
            : bodyKind === "json"
              ? JSON.stringify({ error: "rate_limited" })
              : "",
          { status: 429, headers: { "Retry-After": "300" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(listChecks()).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      retryAfterMs: 300000,
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(refreshDeviceToken).not.toHaveBeenCalled();
    expect(getHealthState()).toBe(before);
    expect(site.token).toBe("access-1");
  },
);

it("retains the session when a preflight refresh is throttled and the old token is rejected", async () => {
  const { getHealthState } = await import("./backend-health.js");
  const before = getHealthState();
  site.tokenExpiresAt = Date.now() - 1000;
  const limited = new ApiError("Refresh limited", {
    status: 429,
    retryAfterMs: 300000,
  });
  vi.mocked(refreshDeviceToken).mockRejectedValueOnce(limited);
  const fetch = stubFetch([{ status: 401 }]);
  vi.stubGlobal("fetch", fetch);
  await expect(listChecks()).rejects.toBe(limited);
  expect(refreshDeviceToken).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(site.token).toBe("access-1");
  expect(getHealthState()).toBe(before);
});
