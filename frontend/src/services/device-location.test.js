import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let getCaptureDeviceLocation, getDeviceLocation, requestLocationPermissionEarly;
beforeEach(async () => {
  vi.resetModules();
  ({
    getCaptureDeviceLocation,
    getDeviceLocation,
    requestLocationPermissionEarly,
  } = await import("./device-location.js"));
  const stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key) => stored.get(key) ?? null),
    setItem: vi.fn((key, value) => stored.set(key, value)),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getDeviceLocation", () => {
  it("returns a fresh valid browser position", async () => {
    const getCurrentPosition = vi.fn((success) =>
      success({ coords: { latitude: 37.7793, longitude: -122.4192 } }),
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });

    await expect(getDeviceLocation()).resolves.toEqual({
      latitude: 37.7793,
      longitude: -122.4192,
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ maximumAge: 0 }),
    );
  });

  it("does not block capture when permission is denied", async () => {
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: (_success, failure) => failure() },
    });

    await expect(getDeviceLocation()).resolves.toBeNull();
  });

  it("does not block capture when the browser never calls back", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn() },
    });

    const location = getDeviceLocation({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);

    await expect(location).resolves.toBeNull();
  });

  it("uses a short deadline for capture-specific requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn() },
    });

    vi.stubGlobal("navigator", {
      ...navigator,
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
    });
    const location = getCaptureDeviceLocation();
    await vi.advanceTimersByTimeAsync(1_999);
    let settled = false;
    void location.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(location).resolves.toBeNull();
  });
});

describe("requestLocationPermissionEarly", () => {
  it("logs the permission state and a successful request without coordinates", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn().mockResolvedValue({ state: "prompt" }),
      },
      geolocation: {
        getCurrentPosition: (success) =>
          success({ coords: { latitude: 37.7793, longitude: -122.4192 } }),
      },
    });

    requestLocationPermissionEarly();
    await vi.waitFor(() => {
      expect(info).toHaveBeenCalledWith("[location] Permission state: prompt");
      expect(info).toHaveBeenCalledWith("[location] Position acquired.");
    });
    expect(info.mock.calls.flat().join(" ")).not.toContain("37.7793");
  });

  it("logs geolocation permission errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (_success, failure) =>
          failure({ code: 1, message: "User denied Geolocation" }),
      },
    });

    requestLocationPermissionEarly();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "[location] Position request failed (code 1): User denied Geolocation",
      );
    });
  });
});

describe("capture permission gating", () => {
  it.each(["denied"])(
    "never requests coordinates when permission is %s",
    async (state) => {
      const getCurrentPosition = vi.fn();
      vi.stubGlobal("navigator", {
        permissions: { query: vi.fn().mockResolvedValue({ state }) },
        geolocation: { getCurrentPosition },
      });
      await expect(getCaptureDeviceLocation()).resolves.toBeNull();
      await expect(getCaptureDeviceLocation()).resolves.toBeNull();
      expect(getCurrentPosition).not.toHaveBeenCalled();
    },
  );

  it("uses fresh coordinates while granted and stops after permission is denied", async () => {
    const query = vi.fn().mockResolvedValue({ state: "granted" });
    const getCurrentPosition = vi.fn((success) =>
      success({ coords: { latitude: 37, longitude: -122 } }),
    );
    vi.stubGlobal("navigator", {
      permissions: { query },
      geolocation: { getCurrentPosition },
    });
    await expect(getCaptureDeviceLocation()).resolves.toEqual({
      latitude: 37,
      longitude: -122,
    });
    query.mockResolvedValue({ state: "denied" });
    await expect(getCaptureDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { query: vi.fn().mockRejectedValue(new Error("Unsupported")) },
  ])(
    "attempts only once when permissions cannot be queried",
    async (permissions) => {
      const getCurrentPosition = vi.fn((_success, failure) => failure());
      vi.stubGlobal("navigator", {
        permissions,
        geolocation: { getCurrentPosition },
      });
      await expect(getCaptureDeviceLocation()).resolves.toBeNull();
      await expect(getCaptureDeviceLocation()).resolves.toBeNull();
      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    },
  );

  it("requests once across repeated startup calls and page reloads", async () => {
    const getCurrentPosition = vi.fn((_success, failure) =>
      failure({ code: 1, message: "Denied" }),
    );
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    requestLocationPermissionEarly();
    requestLocationPermissionEarly();
    vi.resetModules();
    const reloaded = await import("./device-location.js");
    reloaded.requestLocationPermissionEarly();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("deduplicates pending startup requests even when storage is blocked", () => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Blocked");
      },
    });
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    requestLocationPermissionEarly();
    requestLocationPermissionEarly();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });
});

describe("capture fallback prompt", () => {
  it("asks on the first capture when still prompt, but not on every photo", async () => {
    const getCurrentPosition = vi.fn((_success, failure) => failure());
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      geolocation: { getCurrentPosition },
    });
    await expect(getCaptureDeviceLocation()).resolves.toBeNull();
    await expect(getCaptureDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });
  it("does not duplicate a pending startup prompt", async () => {
    vi.useFakeTimers();
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      geolocation: { getCurrentPosition },
    });
    requestLocationPermissionEarly();
    const capture = getCaptureDeviceLocation();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(capture).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });
});

describe("capture reuses startup location", () => {
  function pendingStartup(state = "granted") {
    vi.useFakeTimers();
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state }) },
      geolocation: { getCurrentPosition },
    });
    requestLocationPermissionEarly();
    return getCurrentPosition;
  }

  it("shares startup success with concurrent captures and clears their timers", async () => {
    const request = pendingStartup();
    const captures = [getCaptureDeviceLocation(), getCaptureDeviceLocation()];
    await vi.advanceTimersByTimeAsync(500);
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    expect(await Promise.all(captures)).toEqual([
      { latitude: 37, longitude: -122 },
      { latitude: 37, longitude: -122 },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    request.mockImplementation((success) =>
      success({ coords: { latitude: 38, longitude: -121 } }),
    );
    await expect(getCaptureDeviceLocation()).resolves.toEqual({
      latitude: 38,
      longitude: -121,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("times out capture after two seconds without cancelling startup", async () => {
    const request = pendingStartup();
    const capture = getCaptureDeviceLocation();
    const settled = vi.fn();
    void capture.then(settled);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(capture).resolves.toBeNull();
    const nextCapture = getCaptureDeviceLocation();
    await vi.advanceTimersByTimeAsync(500);
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    await expect(nextCapture).resolves.toEqual({
      latitude: 37,
      longitude: -122,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back on startup failure and requests fresh coordinates afterward", async () => {
    const request = pendingStartup();
    const capture = getCaptureDeviceLocation();
    await vi.advanceTimersByTimeAsync(10);
    request.mock.calls[0][1]({ code: 2, message: "Position unavailable" });
    await expect(capture).resolves.toBeNull();
    request.mockImplementation((success) =>
      success({ coords: { latitude: 38, longitude: -121 } }),
    );
    await expect(getCaptureDeviceLocation()).resolves.toEqual({
      latitude: 38,
      longitude: -121,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("respects explicit denial even while startup is pending", async () => {
    const request = pendingStartup("denied");
    await expect(getCaptureDeviceLocation()).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
