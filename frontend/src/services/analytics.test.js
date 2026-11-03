import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Node environment: browser surfaces are stubbed (error-report.test.js
  pattern). The module is re-imported per test so its page-view dedupe and
  client-hints cache reset. MODE is "test", so analytics is off unless
  localStorage['gnp:analytics'] = 'on'.
*/

/** @type {Record<string, string>} */
let storage;
/** @type {Blob[]} */
let beacons;
/** @type {import("vitest").Mock} */
let sendBeacon;
/** @type {import("vitest").Mock} */
let fetchMock;

/**
 * @typedef {object} BeaconBody
 * @property {string} event
 * @property {string} id
 * @property {string} release
 * @property {string} ts
 * @property {Record<string, unknown>} properties
 */

/** @returns {Promise<BeaconBody[]>} parsed batch of the most recent beacon */
async function lastBatch() {
  return JSON.parse(await beacons[beacons.length - 1].text()).batch;
}

/** @returns {Promise<BeaconBody>} the last event in the most recent beacon */
async function lastBeacon() {
  const batch = await lastBatch();
  return batch[batch.length - 1];
}

/**
 * Events are queued; tests flush explicitly rather than waiting out the
 * timer. Returns the module so callers can destructure after loading.
 * @returns {Promise<typeof import("./analytics.js")>}
 */
async function load() {
  vi.resetModules();
  return import("./analytics.js");
}

beforeEach(() => {
  storage = { "gnp:analytics": "on", "gnp:distinct-id": "device-1" };
  beacons = [];
  sendBeacon = vi.fn((_url, blob) => {
    beacons.push(blob);
    return true;
  });
  fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
  vi.stubGlobal("localStorage", {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => {
      storage[k] = String(v);
    },
    removeItem: (k) => {
      delete storage[k];
    },
  });
  vi.stubGlobal("navigator", {
    sendBeacon,
    userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S911U) TestBrowser/1.0",
    language: "en-US",
    deviceMemory: 2,
    hardwareConcurrency: 4,
    connection: { effectiveType: "4g" },
    userAgentData: {
      platform: "Android",
      mobile: true,
      getHighEntropyValues: vi.fn(async () => ({
        platformVersion: "8.0.0",
        model: "SM-G930F",
      })),
    },
  });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    innerWidth: 412,
    innerHeight: 780,
    devicePixelRatio: 2.6,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("screen", { width: 412, height: 915 });
  vi.stubGlobal("location", {
    origin: "https://app.example",
    pathname: "/today",
    href: "https://app.example/today?code=SECRET",
  });
  vi.stubGlobal("document", { referrer: "https://mail.example/inbox?x=1" });
  vi.stubGlobal("performance", {
    getEntriesByType: () => [{ type: "reload" }],
    now: () => 0,
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackEvent", () => {
  it("is off by default under the test runner", async () => {
    delete storage["gnp:analytics"];
    const { trackEvent } = await load();
    expect(await trackEvent("camera_opened", { flow: "perimeter" })).toBe(
      false,
    );
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("beacons the event with device facts, client hints, and the shared id", async () => {
    const { trackEvent, flushEvents } = await load();
    expect(await trackEvent("camera_opened", { flow: "perimeter" })).toBe(true);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(flushEvents()).toBe(true);
    expect(sendBeacon.mock.calls[0][0]).toBe("/v1/client-events");
    const envelope = JSON.parse(await beacons[0].text());
    expect(envelope.ua).toBe(
      "Mozilla/5.0 (Linux; Android 14; SM-S911U) TestBrowser/1.0",
    );
    const body = await lastBeacon();
    expect(body.event).toBe("camera_opened");
    expect(body.id).toBe("device-1");
    expect(body.release).toBe("dev");
    expect(body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.properties).toEqual({
      $screen_width: 412,
      $screen_height: 915,
      $viewport_width: 412,
      $viewport_height: 780,
      device_pixel_ratio: 2.6,
      $browser_language: "en-US",
      device_memory_gb: 2,
      hardware_concurrency: 4,
      connection_type: "4g",
      display_mode: "browser",
      platform: "Android",
      ua_mobile: true,
      platform_version: "8.0.0",
      device_model: "SM-G930F",
      flow: "perimeter",
    });
  });

  it("falls back to fetch keepalive when sendBeacon is unavailable", async () => {
    vi.stubGlobal("navigator", { language: "en" });
    const { trackEvent, flushEvents } = await load();
    expect(await trackEvent("camera_opened")).toBe(true);
    flushEvents();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/client-events");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body).batch[0].event).toBe("camera_opened");
  });

  it("survives missing browser surfaces", async () => {
    vi.stubGlobal("screen", undefined);
    vi.stubGlobal("performance", undefined);
    vi.stubGlobal("navigator", { sendBeacon });
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    const { trackEvent, flushEvents } = await load();
    expect(await trackEvent("camera_opened")).toBe(true);
    flushEvents();
    const body = await lastBeacon();
    expect(body.properties).not.toHaveProperty("$screen_width");
  });
});

describe("batching", () => {
  it("sends several events as one beacon after the quiet period", async () => {
    vi.useFakeTimers();
    try {
      const { trackEvent, FLUSH_DELAY_MS } = await load();
      await trackEvent("camera_opened", { flow: "perimeter" });
      await trackEvent("photo_picked", { flow: "perimeter" });
      await trackEvent("photo_pipeline", { stage: "presign" });
      expect(sendBeacon).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS + 1);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const batch = await lastBatch();
      expect(batch.map((e) => e.event)).toEqual([
        "camera_opened",
        "photo_picked",
        "photo_pipeline",
      ]);
      // The queue is drained: the timer does not fire again.
      await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes early so no beacon body exceeds MAX_BATCH_BYTES", async () => {
    vi.useFakeTimers();
    try {
      const { trackEvent, MAX_BATCH_BYTES, MAX_BATCH } = await load();
      // Realistic photo_pipeline payload: ids plus stage facts, ~750 bytes
      // with the device properties merged in.
      const props = {
        check_id: "01J9ZK3Q8X2M4N6P8R0T2V4W6Y",
        attempt_id: "6f1d2c3b-4a5e-4f60-8b7c-9d0e1f2a3b4c",
        artifact_id: "01J9ZK3Q8X2M4N6P8R0T2V4W6Z",
        photo_bytes: 2345678,
        stage: "register",
        outcome: "completed",
        elapsed_ms: 1234,
        http_status: 0,
        online: true,
        visibility: "visible",
      };
      let sent = 0;
      for (let i = 0; i < MAX_BATCH; i++) {
        await trackEvent("photo_pipeline", { ...props, elapsed_ms: i });
        sent++;
        if (sendBeacon.mock.calls.length > 0) break;
      }
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const body = await beacons[0].text();
      expect(body.length).toBeLessThanOrEqual(MAX_BATCH_BYTES + 600);
      const batch = JSON.parse(body).batch;
      expect(batch.length).toBeGreaterThan(1);
      // The event that would have overflowed is queued for the next batch.
      expect(batch).toHaveLength(sent - 1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendBeacon).toHaveBeenCalledTimes(2);
      expect(await lastBatch()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never sends a beacon without the user agent when the browser lacks one", async () => {
    vi.stubGlobal("navigator", { sendBeacon, language: "en" });
    const { trackEvent, flushEvents } = await load();
    await trackEvent("camera_opened");
    flushEvents();
    const envelope = JSON.parse(await beacons[0].text());
    expect(envelope).not.toHaveProperty("ua");
    expect(envelope.batch).toHaveLength(1);
  });

  it("flushes when the page is hidden or unloading", async () => {
    /** @type {Record<string, () => void>} */
    const docListeners = {};
    /** @type {Record<string, () => void>} */
    const winListeners = {};
    vi.stubGlobal("document", {
      referrer: "",
      visibilityState: "visible",
      addEventListener: (
        /** @type {string} */ t,
        /** @type {() => void} */ fn,
      ) => {
        docListeners[t] = fn;
      },
    });
    vi.stubGlobal("window", {
      innerWidth: 412,
      innerHeight: 780,
      devicePixelRatio: 2,
      matchMedia: () => ({ matches: false }),
      addEventListener: (
        /** @type {string} */ t,
        /** @type {() => void} */ fn,
      ) => {
        winListeners[t] = fn;
      },
    });
    const { trackEvent } = await load();
    await trackEvent("camera_opened", { flow: "perimeter" });
    expect(sendBeacon).not.toHaveBeenCalled();
    /** @type {{ visibilityState: string }} */ (document).visibilityState =
      "hidden";
    docListeners.visibilitychange();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    await trackEvent("photo_picked", { flow: "perimeter" });
    winListeners.pagehide();
    expect(sendBeacon).toHaveBeenCalledTimes(2);
    // Nothing queued: pagehide with an empty queue sends nothing.
    winListeners.pagehide();
    expect(sendBeacon).toHaveBeenCalledTimes(2);
  });

  it("sends at once when an event is queued after the page is already hidden", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("document", {
        visibilityState: "hidden",
        addEventListener: () => {},
      });
      vi.stubGlobal("window", { addEventListener: () => {} });
      const { trackEvent } = await load();
      await trackEvent("camera_opened", { flow: "perimeter" });
      // No quiet period: the hidden flush already ran, and a timer may
      // never fire once the camera has the screen.
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      expect(await lastBatch()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendBeacon).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("trackPageView", () => {
  it("sends origin + pathname only, with load type and referrer host on the first view", async () => {
    const { trackPageView, flushEvents } = await load();
    await trackPageView("/today");
    flushEvents();
    const body = await lastBeacon();
    expect(body.event).toBe("$pageview");
    expect(body.properties.$current_url).toBe("https://app.example/today");
    expect(body.properties.$pathname).toBe("/today");
    expect(body.properties.navigation_type).toBe("reload");
    expect(body.properties.$referring_domain).toBe("mail.example");
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("collapses consecutive views of the same path and drops load facts after the first", async () => {
    const { trackPageView, flushEvents } = await load();
    await trackPageView("/today");
    expect(await trackPageView("/today")).toBe(false);
    await trackPageView("/check");
    flushEvents();
    const batch = await lastBatch();
    expect(batch).toHaveLength(2);
    const second = batch[1];
    expect(second.properties.$pathname).toBe("/check");
    expect(second.properties).not.toHaveProperty("navigation_type");
    expect(second.properties).not.toHaveProperty("$referring_domain");
  });

  it("startPageViewTracking views the current route and every change", async () => {
    const { startPageViewTracking, flushEvents } = await load();
    /** @type {(route: string) => void} */
    let listener = () => {};
    const unsubscribe = vi.fn();
    startPageViewTracking({
      currentRoute: () => "/today",
      onRouteChange: (fn) => {
        listener = fn;
        return unsubscribe;
      },
    });
    listener("/check");
    listener("/check/describe");
    await Promise.resolve();
    await Promise.resolve();
    flushEvents();
    expect(await lastBatch()).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("navigationType and referringDomain never throw", async () => {
    vi.stubGlobal("performance", undefined);
    vi.stubGlobal("document", { referrer: "not a url" });
    const { navigationType, referringDomain } = await load();
    expect(navigationType()).toBe("");
    expect(referringDomain()).toBe("");
  });
});
