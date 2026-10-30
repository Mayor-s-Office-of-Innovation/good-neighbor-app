import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock("./analytics.js", () => ({ trackEvent }));

let readCaptureDeviceLocation,
  getDeviceLocation,
  requestLocationPermissionEarly;
let getLastDeviceLocation, onDeviceLocationChange, refreshGrantedDeviceLocation;
let getSiteCheckDeviceLocation, startCaptureDeviceLocation;
beforeEach(async () => {
  vi.resetModules();
  trackEvent.mockClear();
  ({
    readCaptureDeviceLocation,
    getDeviceLocation,
    requestLocationPermissionEarly,
    getLastDeviceLocation,
    onDeviceLocationChange,
    refreshGrantedDeviceLocation,
    getSiteCheckDeviceLocation,
    startCaptureDeviceLocation,
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
  it("publishes the last fetch and only refreshes home when permission is granted", async () => {
    const listener = vi.fn();
    const unsubscribe = onDeviceLocationChange(listener);
    const getCurrentPosition = vi.fn((success) =>
      success({ coords: { latitude: 37.77, longitude: -122.42 } }),
    );
    const query = vi
      .fn()
      .mockResolvedValueOnce({ state: "prompt" })
      .mockResolvedValue({ state: "granted" });
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition },
      permissions: { query },
    });
    await expect(refreshGrantedDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await expect(refreshGrantedDeviceLocation()).resolves.toEqual({
      latitude: 37.77,
      longitude: -122.42,
    });
    expect(getLastDeviceLocation()).toEqual({
      latitude: 37.77,
      longitude: -122.42,
    });
    expect(listener).toHaveBeenCalledWith({
      latitude: 37.77,
      longitude: -122.42,
    });
    unsubscribe();
  });
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

  it("keeps GPS accuracy, rounded to whole metres", async () => {
    vi.stubGlobal("navigator", {
      geolocation: {
        getCurrentPosition: (success) =>
          success({
            coords: { latitude: 37.7793, longitude: -122.4192, accuracy: 17.6 },
          }),
      },
    });

    await expect(getDeviceLocation()).resolves.toEqual({
      latitude: 37.7793,
      longitude: -122.4192,
      accuracyMeters: 18,
    });
  });

  it("uses a bounded deadline for capture-specific requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition: vi.fn() },
    });

    vi.stubGlobal("navigator", {
      ...navigator,
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
    });
    const location = readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(9_999);
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

describe("site-start location check", () => {
  it("does not re-prompt when browser permission is prompt", async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      geolocation: { getCurrentPosition },
    });
    await expect(getSiteCheckDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("uses a bounded user-initiated position request without the Permissions API", async () => {
    const getCurrentPosition = vi.fn((success) =>
      success({ coords: { latitude: 37.7873, longitude: -122.4132 } }),
    );
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition },
    });

    await expect(refreshGrantedDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await expect(getSiteCheckDeviceLocation()).resolves.toEqual({
      latitude: 37.7873,
      longitude: -122.4132,
    });
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ timeout: 2_000, maximumAge: 30_000 }),
    );
  });

  it("does not repeat a denied prompt at capture or another site-start action", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getCurrentPosition = vi.fn((_success, failure) =>
      failure({ code: 1, message: "Denied" }),
    );
    vi.stubGlobal("navigator", {
      geolocation: { getCurrentPosition },
    });

    await expect(getSiteCheckDeviceLocation()).resolves.toBeNull();
    await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
    await expect(getSiteCheckDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it("reuses a recent successful fix without waiting or prompting again", async () => {
    const getCurrentPosition = vi.fn((success) =>
      success({ coords: { latitude: 37.7873, longitude: -122.4132 } }),
    );
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      geolocation: { getCurrentPosition },
    });
    await getDeviceLocation();
    await expect(getSiteCheckDeviceLocation()).resolves.toEqual({
      latitude: 37.7873,
      longitude: -122.4132,
    });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("does not use a cached fix after permission is denied", async () => {
    const query = vi.fn().mockResolvedValue({ state: "granted" });
    const getCurrentPosition = vi.fn((success) =>
      success({ coords: { latitude: 37.7873, longitude: -122.4132 } }),
    );
    vi.stubGlobal("navigator", {
      permissions: { query },
      geolocation: { getCurrentPosition },
    });
    await getDeviceLocation();
    query.mockResolvedValue({ state: "denied" });
    await expect(getSiteCheckDeviceLocation()).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("bounds a granted fresh lookup to two seconds", async () => {
    vi.useFakeTimers();
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      geolocation: { getCurrentPosition },
    });
    const location = getSiteCheckDeviceLocation();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(location).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ timeout: 2_000, maximumAge: 30_000 }),
    );
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
      await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
      await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
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
    await expect(readCaptureDeviceLocation().later).resolves.toEqual({
      latitude: 37,
      longitude: -122,
    });
    query.mockResolvedValue({ state: "denied" });
    await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
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
      await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
      await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
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
    await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
    await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
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
    const capture = readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(10_000);
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
    const captures = [
      readCaptureDeviceLocation().later,
      readCaptureDeviceLocation().later,
    ];
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
    await expect(readCaptureDeviceLocation().later).resolves.toEqual({
      latitude: 38,
      longitude: -121,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("shares a startup fix that arrives late but within the capture wait", async () => {
    const request = pendingStartup();
    await vi.advanceTimersByTimeAsync(5_000);
    const capture = readCaptureDeviceLocation().later;
    const settled = vi.fn();
    void capture.then(settled);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).not.toHaveBeenCalled();
    const nextCapture = readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(0);
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    await expect(capture).resolves.toEqual({ latitude: 37, longitude: -122 });
    await expect(nextCapture).resolves.toEqual({
      latitude: 37,
      longitude: -122,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("falls back on startup failure and requests fresh coordinates afterward", async () => {
    const request = pendingStartup();
    const capture = readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(10);
    request.mock.calls[0][1]({ code: 2, message: "Position unavailable" });
    await expect(capture).resolves.toBeNull();
    request.mockImplementation((success) =>
      success({ coords: { latitude: 38, longitude: -121 } }),
    );
    await expect(readCaptureDeviceLocation().later).resolves.toEqual({
      latitude: 38,
      longitude: -121,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("respects explicit denial even while startup is pending", async () => {
    const request = pendingStartup("denied");
    await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("capture location for a cold GPS (#560)", () => {
  function granted() {
    vi.useFakeTimers();
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      geolocation: { getCurrentPosition },
    });
    return getCurrentPosition;
  }

  it("never holds up the upload and reports a fix that came after it", async () => {
    const request = granted();
    const read = readCaptureDeviceLocation("perimeter");
    await vi.advanceTimersByTimeAsync(0);
    expect(read.atUpload()).toBeNull();
    await vi.advanceTimersByTimeAsync(6_000);
    request.mock.calls[0][0]({
      coords: { latitude: 37, longitude: -122, accuracy: 12 },
    });
    await expect(read.later).resolves.toEqual({
      latitude: 37,
      longitude: -122,
      accuracyMeters: 12,
    });
    expect(read.atUpload()).toBeNull();
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledWith("photo_location", {
      flow: "perimeter",
      location_outcome: "acquired",
      location_wait_ms: 6_000,
      location_accuracy_m: 12,
      location_sent_with_upload: false,
      permission_state: "granted",
    });
  });

  it("sends a fix that is ready at upload with the photo", async () => {
    const request = granted();
    const read = readCaptureDeviceLocation("perimeter");
    await vi.advanceTimersByTimeAsync(0);
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    await read.later;
    expect(read.atUpload()).toEqual({ latitude: 37, longitude: -122 });
    expect(trackEvent).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledWith(
      "photo_location",
      expect.objectContaining({
        location_outcome: "acquired",
        location_sent_with_upload: true,
      }),
    );
  });

  it("sends a ready Start reading with a photo uploaded before the permission check returns", async () => {
    const request = granted();
    await startCaptureDeviceLocation();
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    await vi.advanceTimersByTimeAsync(0);
    const read = readCaptureDeviceLocation();
    expect(read.atUpload()).toEqual({ latitude: 37, longitude: -122 });
  });

  it("reuses the read started when the flow opened", async () => {
    const request = granted();
    await startCaptureDeviceLocation();
    expect(request).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: true, maximumAge: 0 }),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const capture = readCaptureDeviceLocation("single-problem").later;
    await vi.advanceTimersByTimeAsync(3_000);
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    await expect(capture).resolves.toEqual({ latitude: 37, longitude: -122 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("serves one photo per early read and drops reads older than a minute", async () => {
    const request = granted();
    await startCaptureDeviceLocation();
    request.mock.calls[0][0]({ coords: { latitude: 37, longitude: -122 } });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(readCaptureDeviceLocation().later).resolves.toEqual({
      latitude: 37,
      longitude: -122,
    });

    const second = readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    request.mock.calls[1][0]({ coords: { latitude: 38, longitude: -121 } });
    await expect(second).resolves.toEqual({ latitude: 38, longitude: -121 });

    await startCaptureDeviceLocation();
    request.mock.calls[2][0]({ coords: { latitude: 39, longitude: -120 } });
    await vi.advanceTimersByTimeAsync(60_001);
    void readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("asks again at capture when the early read failed", async () => {
    const request = granted();
    await startCaptureDeviceLocation();
    request.mock.calls[0][1]({ code: 2, message: "Position unavailable" });
    await vi.advanceTimersByTimeAsync(0);
    void readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("never starts an early read when permission is denied", async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "denied" }) },
      geolocation: { getCurrentPosition },
    });
    await startCaptureDeviceLocation();
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it("asks on Start when the browser has reset permission to prompt", async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      geolocation: { getCurrentPosition },
    });
    await startCaptureDeviceLocation();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    getCurrentPosition.mock.calls[0][0]({
      coords: { latitude: 37, longitude: -122, accuracy: 8 },
    });
    await expect(readCaptureDeviceLocation().later).resolves.toEqual({
      latitude: 37,
      longitude: -122,
      accuracyMeters: 8,
    });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask again at the photo after a dismissed Start prompt", async () => {
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      geolocation: { getCurrentPosition },
    });
    await startCaptureDeviceLocation();
    getCurrentPosition.mock.calls[0][1]({ code: 1, message: "Dismissed" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(readCaptureDeviceLocation().later).resolves.toBeNull();
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it("still reads at the photo without the Permissions API once the Start reading is stale", async () => {
    vi.useFakeTimers();
    const getCurrentPosition = vi.fn();
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    await startCaptureDeviceLocation();
    getCurrentPosition.mock.calls[0][0]({
      coords: { latitude: 37, longitude: -122 },
    });
    await vi.advanceTimersByTimeAsync(60_001);
    void readCaptureDeviceLocation().later;
    await vi.advanceTimersByTimeAsync(0);
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
  });

  it("reports why a photo has no location, without coordinates", async () => {
    vi.stubGlobal("navigator", {
      permissions: { query: vi.fn().mockResolvedValue({ state: "denied" }) },
      geolocation: { getCurrentPosition: vi.fn() },
    });
    const denied = readCaptureDeviceLocation("perimeter");
    await denied.later;
    expect(denied.atUpload()).toBeNull();
    expect(trackEvent).toHaveBeenCalledWith(
      "photo_location",
      expect.objectContaining({
        location_outcome: "denied",
        permission_state: "denied",
      }),
    );

    const request = granted();
    const read = readCaptureDeviceLocation("perimeter");
    await vi.advanceTimersByTimeAsync(0);
    read.atUpload();
    await vi.advanceTimersByTimeAsync(10_000);
    await read.later;
    expect(request).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenLastCalledWith(
      "photo_location",
      expect.objectContaining({ location_outcome: "timeout" }),
    );
    expect(JSON.stringify(trackEvent.mock.calls)).not.toMatch(/latitude|-122/);
  });

  it("sends no event when the caller names no flow", async () => {
    granted();
    const read = readCaptureDeviceLocation();
    read.atUpload();
    await vi.advanceTimersByTimeAsync(10_000);
    await read.later;
    expect(trackEvent).not.toHaveBeenCalled();
  });
});
