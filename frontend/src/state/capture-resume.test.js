import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_OPEN_TTL_MS,
  captureRouteFlow,
  captureRouteToRestore,
  clearCameraOpen,
  captureResumeProperties,
  markCameraOpen,
  readCameraOpen,
} from "./capture-resume.js";

/** Minimal Storage stand-in; vitest runs these modules under node. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    size: () => map.size,
  };
}

const NOW = 1_700_000_000_000;

describe("camera-open marker", () => {
  let storage;
  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips the route and age", () => {
    markCameraOpen("/check", NOW);
    expect(readCameraOpen(NOW + 5_000)).toEqual({
      route: "/check",
      at: NOW,
      ageMs: 5_000,
    });
  });

  it("is absent after clear", () => {
    markCameraOpen("/check", NOW);
    clearCameraOpen();
    expect(readCameraOpen(NOW)).toBeNull();
  });

  it("expires past the TTL and drops the stale entry", () => {
    markCameraOpen("/check", NOW);
    expect(readCameraOpen(NOW + CAMERA_OPEN_TTL_MS + 1)).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it("treats a marker from the future or malformed JSON as absent", () => {
    markCameraOpen("/check", NOW + 60_000);
    expect(readCameraOpen(NOW)).toBeNull();
    storage.setItem("gnp:camera-open", "{not json");
    expect(readCameraOpen(NOW)).toBeNull();
    storage.setItem("gnp:camera-open", JSON.stringify({ at: NOW }));
    expect(readCameraOpen(NOW)).toBeNull();
  });

  it("never throws when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    });
    expect(() => markCameraOpen("/check", NOW)).not.toThrow();
    expect(readCameraOpen(NOW)).toBeNull();
    expect(() => clearCameraOpen()).not.toThrow();
  });
});

describe("captureRouteFlow", () => {
  it("maps the two capture routes and nothing else", () => {
    expect(captureRouteFlow("/check")).toBe("perimeter");
    expect(captureRouteFlow("/problem")).toBe("single-problem");
    expect(captureRouteFlow("/check/describe")).toBeNull();
    expect(captureRouteFlow("/today")).toBeNull();
    expect(captureRouteFlow("toString")).toBeNull();
  });
});

describe("captureRouteToRestore", () => {
  let storage;
  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const drafts = (flows) => vi.fn(async (flow) => flows.includes(flow));

  it("re-enters the check when home boots with a fresh marker and a draft", async () => {
    markCameraOpen("/check", NOW);
    const hasDraft = drafts(["perimeter"]);
    const result = await captureRouteToRestore({
      route: "/today",
      hasDraft,
      now: NOW + 30_000,
    });
    expect(result?.route).toBe("/check");
    expect(result?.flow).toBe("perimeter");
    expect(result?.marker.ageMs).toBe(30_000);
    expect(hasDraft).toHaveBeenCalledWith("perimeter");
  });

  it("re-enters a single-issue report the same way", async () => {
    markCameraOpen("/problem", NOW);
    const result = await captureRouteToRestore({
      route: "/today",
      hasDraft: drafts(["single-problem"]),
      now: NOW,
    });
    expect(result?.route).toBe("/problem");
    expect(result?.flow).toBe("single-problem");
  });

  it("does nothing when the boot did not land on home", async () => {
    markCameraOpen("/check", NOW);
    const hasDraft = drafts(["perimeter"]);
    expect(
      await captureRouteToRestore({ route: "/check", hasDraft, now: NOW }),
    ).toBeNull();
    expect(hasDraft).not.toHaveBeenCalled();
    // Marker is left for the capture screen to clear on connect.
    expect(readCameraOpen(NOW)).not.toBeNull();
  });

  it("does nothing without a marker", async () => {
    expect(
      await captureRouteToRestore({
        route: "/today",
        hasDraft: drafts(["perimeter"]),
        now: NOW,
      }),
    ).toBeNull();
  });

  it("ignores an expired marker", async () => {
    markCameraOpen("/check", NOW);
    expect(
      await captureRouteToRestore({
        route: "/today",
        hasDraft: drafts(["perimeter"]),
        now: NOW + CAMERA_OPEN_TTL_MS + 1,
      }),
    ).toBeNull();
  });

  it("stays home and clears the marker when the draft is gone", async () => {
    markCameraOpen("/check", NOW);
    expect(
      await captureRouteToRestore({
        route: "/today",
        hasDraft: drafts([]),
        now: NOW,
      }),
    ).toBeNull();
    expect(storage.size()).toBe(0);
  });

  it("stays home and clears a marker for a non-capture route", async () => {
    markCameraOpen("/site-admin", NOW);
    const hasDraft = drafts(["perimeter"]);
    expect(
      await captureRouteToRestore({ route: "/today", hasDraft, now: NOW }),
    ).toBeNull();
    expect(hasDraft).not.toHaveBeenCalled();
    expect(storage.size()).toBe(0);
  });
});

describe("captureResumeProperties", () => {
  const restore = {
    route: "/check",
    flow: "perimeter",
    marker: { route: "/check", at: NOW, ageMs: 42_400 },
  };

  it("names the resume and how the document arrived", () => {
    expect(
      captureResumeProperties(restore, {
        pathname: "/",
        navigationType: "navigate",
        referrerHost: "mail.example.com",
      }),
    ).toEqual({
      route: "/check",
      flow: "perimeter",
      marker_age_s: 42,
      navigation_type: "navigate",
      landing_path: "/",
      $referring_domain: "mail.example.com",
    });
  });

  it("omits unknown environment facts", () => {
    expect(captureResumeProperties(restore, {})).toEqual({
      route: "/check",
      flow: "perimeter",
      marker_age_s: 42,
    });
  });
});
