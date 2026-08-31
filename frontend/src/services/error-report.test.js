import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Tests for services/error-report.js (lean client error capture).

  Node environment (repo default): the browser surfaces the module touches are
  stubbed here — window, localStorage, navigator, crypto, location — following
  the vi.stubGlobal pattern of today-view.test.js. Error listeners registered
  on the stubbed window are captured and driven directly. The module is
  re-imported per test (vi.resetModules) so its module-scope dedupe/rate state
  resets.

  import.meta.env.MODE is "test" under vitest, so the module's default is off
  (instrument.js convention). Tests opt in via localStorage['gnp:errors']='on',
  which exercises the force-on override path.
*/

/** @type {Record<string, string>} */
let storage;
/** @type {Blob[]} */
let beaconBlobs;
/** @type {string[]} */
let beaconBodies;
/** @type {any} */
let sendBeacon;
/** @type {any} */
let fetchMock;
/** @type {Record<string, any>} */
let listeners;
let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  storage = {};
  /** @type {Blob[]} */
  beaconBlobs = [];
  /** @type {string[]} */
  beaconBodies = [];
  sendBeacon = vi.fn(
    /**
     * @param {string} _url
     * @param {Blob} blob
     * @returns {boolean}
     */
    (_url, blob) => {
      beaconBlobs.push(blob);
      return true;
    },
  );
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  listeners = {};

  vi.stubGlobal("localStorage", {
    getItem: (/** @type {string} */ k) => storage[k] ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
      storage[k] = String(v);
    },
  });
  vi.stubGlobal("crypto", { randomUUID: () => `uuid-${++uuidCounter}` });
  vi.stubGlobal("navigator", { sendBeacon });
  vi.stubGlobal("location", { pathname: "/check?secret=1" });
  vi.stubGlobal("window", {
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => {
      listeners[type] = fn;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (/** @type {any} */ (globalThis).__RELEASE__);
});

/** @returns {Promise<typeof import("./error-report.js")>} */
function load() {
  return import("./error-report.js");
}

/** @returns {Promise<void>} opt-in via the kill-switch override, then install */
async function loadEnabled() {
  storage["gnp:errors"] = "on";
  const mod = await load();
  mod.installErrorReporting();
}

/**
 * Fire an error through the registered listener.
 * @param {string} message
 * @param {Error | undefined} error
 * @returns {void}
 */
function fireError(message, error) {
  listeners.error?.({
    message,
    error,
    filename: "/assets/app.js?secret=1",
  });
}

/** @param {Blob} blob @returns {Promise<string>} */
function blobText(blob) {
  return blob.text();
}

/** @returns {Promise<void>} drain captured beacon blobs into JSON strings */
async function drainBlobs() {
  beaconBodies = await Promise.all(beaconBlobs.map(blobText));
}

/** @returns {Promise<any>} most recent beacon payload, parsed */
async function lastPayload() {
  await drainBlobs();
  return JSON.parse(beaconBodies.at(-1) ?? "{}");
}

/** @returns {Promise<void>} refresh beaconBodies from captured blobs */
async function syncBodies() {
  await drainBlobs();
}

describe("enablement (instrument.js conventions)", () => {
  it("installs nothing in test mode without the on flag", async () => {
    const mod = await load();
    mod.installErrorReporting();
    expect(listeners.error).toBeUndefined();
  });

  it("gnp:errors=on forces listeners on even in test mode", async () => {
    await loadEnabled();
    expect(listeners.error).toBeTypeOf("function");
    expect(listeners.unhandledrejection).toBeTypeOf("function");
  });

  it("gnp:errors=off keeps it off (kill switch)", async () => {
    storage["gnp:errors"] = "off";
    const mod = await load();
    mod.installErrorReporting();
    expect(listeners.error).toBeUndefined();
  });
});

describe("capture + payload", () => {
  it("reports an uncaught error with the scrubbed payload shape", async () => {
    await loadEnabled();

    listeners.error({ message: "boom", error: new Error("boom") });

    await syncBodies();
    expect(beaconBodies).toHaveLength(1);
    const payload = await lastPayload();
    expect(payload).toMatchObject({
      type: "Error",
      message: "boom",
      source: "/check", // pathname only — the stubbed location's query never leaks
      release: "dev",
      id: "uuid-1",
    });
    expect(payload.stack).toMatch(/Error: boom/);
    expect(typeof payload.ts).toBe("string");
    expect(JSON.stringify(payload)).not.toContain("secret");
    // Allowlisted fields only.
    expect(Object.keys(payload).sort()).toEqual([
      "id",
      "message",
      "release",
      "source",
      "stack",
      "ts",
      "type",
    ]);
  });

  it("skips resource-load noise (message but no error object)", async () => {
    await loadEnabled();

    listeners.error({ message: "Script error.", error: undefined });

    await syncBodies();
    expect(beaconBodies).toHaveLength(0);
  });

  it("reports unhandled rejections (Error, string, exotic, undefined)", async () => {
    await loadEnabled();

    listeners.unhandledrejection({ reason: new Error("async blew up") });
    listeners.unhandledrejection({ reason: "plain string" });
    listeners.unhandledrejection({ reason: { exotic: true } });
    listeners.unhandledrejection({ reason: undefined });

    await syncBodies();
    expect(beaconBodies).toHaveLength(3);
    const [a, b, c] = beaconBodies.map((x) => JSON.parse(x));
    expect(a).toMatchObject({
      type: "UnhandledRejection",
      message: "async blew up",
    });
    expect(a.stack).toBeTypeOf("string");
    expect(b).toMatchObject({ message: "plain string" });
    expect(c.stack).toBeUndefined();
    expect(c.message).toBe("UnhandledRejection");
  });

  it("dedupes identical type+message, still sends distinct ones", async () => {
    await loadEnabled();

    fireError("boom", new Error("boom"));
    fireError("boom", new Error("boom"));
    fireError("different", new Error("other"));

    await syncBodies();
    expect(beaconBodies).toHaveLength(2);
  });

  it("rate-caps distinct errors at 5 per window", async () => {
    await loadEnabled();

    for (let i = 0; i < 8; i++) {
      fireError(`err-${i}`, new Error(`distinct ${i}`));
    }

    await syncBodies();
    expect(beaconBodies).toHaveLength(5);
  });

  it("caps oversized stacks and messages", async () => {
    await loadEnabled();
    /** @type {any} */
    const error = new Error("boom");
    error.stack = "s".repeat(30000);

    listeners.error({ message: "m".repeat(5000), error });

    const payload = await lastPayload();
    expect(payload.message.length).toBeLessThanOrEqual(2000);
    expect(payload.stack.length).toBeLessThanOrEqual(16000);
  });

  it("falls back to fetch keepalive when beacon is unavailable", async () => {
    vi.stubGlobal("navigator", {}); // beacon-less browser
    await loadEnabled();

    listeners.error({ message: "boom", error: new Error("boom") });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/client-errors",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
  });

  it("never throws out of the capture path", async () => {
    await loadEnabled();
    sendBeacon.mockImplementation(() => {
      throw new Error("beacon exploded");
    });

    expect(() =>
      listeners.error({ message: "boom", error: new Error("boom") }),
    ).not.toThrow();
  });

  it("keeps one distinct id per browser (persisted)", async () => {
    storage["gnp:distinct-id"] = "stable-id";
    await loadEnabled();

    listeners.error({ message: "a", error: new Error("a") });
    listeners.unhandledrejection({ reason: new Error("b") });

    await syncBodies();
    const ids = beaconBodies.map((x) => JSON.parse(x).id);
    expect(ids).toEqual(["stable-id", "stable-id"]);
  });

  it("honors the __RELEASE__ build define", async () => {
    storage["gnp:errors"] = "on";
    /** @type {any} */ (globalThis).__RELEASE__ = "abc123";
    const mod = await load();
    mod.installErrorReporting();

    fireError("boom", new Error("boom"));

    const payload = await lastPayload();
    expect(payload.release).toBe("abc123");
    delete (/** @type {any} */ (globalThis).__RELEASE__);
  });
});
