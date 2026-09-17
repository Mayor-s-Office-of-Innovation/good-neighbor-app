import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDeviceLocation,
  requestLocationPermissionEarly,
} from "./device-location.js";

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
