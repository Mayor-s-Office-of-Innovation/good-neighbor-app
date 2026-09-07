import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ReauthRequiredError } from "./api.js";
import { updateSiteSession } from "../db.js";

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
  return vi.fn(() => {
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
  updateSiteSession: vi.fn((session) => {
    // Mirror the real merge: token fields replace, identity stays.
    site = { ...site, ...session };
    return Promise.resolve(site);
  }),
}));

// instrument.js is real (harmless under test), refreshDeviceToken is mocked:
// its own contract is covered by devices.test.js.
vi.mock("./devices.js", () => ({
  refreshDeviceToken: vi.fn(),
}));

import { refreshDeviceToken } from "./devices.js";
import { listChecks } from "./api.js";

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
    expect(refreshDeviceToken).toHaveBeenCalledWith("refresh-1");
    expect(updateSiteSession).toHaveBeenCalledWith(freshSession);
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

  it("maps a rejected refresh (401) to ReauthRequiredError", async () => {
    vi.stubGlobal("fetch", stubFetch([{ status: 401 }]));
    vi.mocked(refreshDeviceToken).mockRejectedValue(
      new ApiError("refresh rejected", { status: 401 }),
    );

    await expect(listChecks()).rejects.toBeInstanceOf(ReauthRequiredError);
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

    // R2 legitimately used refresh-1 (it was current at its start); R1's late
    // leg must have re-read the stored record and sent refresh-2 — the dead
    // token is never replayed.
    const tokens = vi.mocked(refreshDeviceToken).mock.calls.map((c) => c[0]);
    expect(tokens).toEqual(["refresh-1", "refresh-2"]);
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
});
