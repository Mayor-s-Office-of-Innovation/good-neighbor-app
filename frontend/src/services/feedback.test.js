import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  Tests for services/feedback.js (in-app feedback POST service).

  Node environment (repo default): browser surfaces (location, localStorage,
  crypto) are stubbed following the vi.stubGlobal pattern of
  error-report.test.js. The module is re-imported per test where module state
  matters (here it doesn't — the service is stateless), but we re-import once
  after stubs so import.meta.env reads see the test env.
*/

/** @type {Record<string, string>} */
let storage;
/** @type {any} */
let fetchMock;
let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  storage = {};
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { pathname: "/today" });
  vi.stubGlobal("localStorage", {
    getItem: (/** @type {string} */ k) => storage[k] ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
      storage[k] = String(v);
    },
  });
  vi.stubGlobal("crypto", { randomUUID: () => `uuid-${++uuidCounter}` });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const { sendFeedback } = await import("./feedback.js");

/**
 * The JSON body most recently POSTed.
 * @returns {any} parsed body of the last fetch call
 */
function lastBody() {
  const init = /** @type {any} */ (fetchMock.mock.calls.at(-1)?.[1]) ?? {};
  return JSON.parse(init.body);
}

/**
 * The URL most recently POSTed.
 * @returns {string}
 */
function lastUrl() {
  return /** @type {string} */ (fetchMock.mock.calls.at(-1)?.[0]);
}

describe("sendFeedback", () => {
  it("POSTs a scrubbed, context-stamped payload to /v1/feedback", async () => {
    storage["gnp:distinct-id"] = "device-uuid";
    await sendFeedback({ message: "  Photos upload slowly  ", site: "M0101" });

    expect(lastUrl()).toBe("/v1/feedback");
    const init = /** @type {any} */ (fetchMock.mock.calls.at(-1)?.[1]);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.keepalive).toBe(true);

    expect(JSON.parse(init.body)).toEqual({
      message: "Photos upload slowly",
      page: "/today",
      site: "M0101",
      release: "dev",
      id: "device-uuid",
      ts: expect.any(String),
    });
  });

  it("resolves on the always-204 handler response", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    await expect(sendFeedback({ message: "hi" })).resolves.toBeUndefined();
  });

  it("rejects on non-2xx so the UI can offer a retry", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(sendFeedback({ message: "hi" })).rejects.toThrow(
      /Feedback POST failed: 500/,
    );
  });

  it("rejects on a transport failure", async () => {
    fetchMock.mockRejectedValue(new TypeError("network down"));
    await expect(sendFeedback({ message: "hi" })).rejects.toThrow(
      TypeError,
    );
  });

  it("rejects on an empty/whitespace-only message without calling fetch", async () => {
    await expect(sendFeedback({ message: "   " })).rejects.toThrow(
      /empty/,
    );
    await expect(sendFeedback({ message: undefined })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the message client-side at 2000 chars", async () => {
    await sendFeedback({ message: "m".repeat(5000) });
    expect(lastBody().message.length).toBe(2000);
  });

  it("omits site when not provided or falsy", async () => {
    await sendFeedback({ message: "hi" });
    expect("site" in lastBody()).toBe(false);

    await sendFeedback({ message: "hi", site: "" });
    expect("site" in lastBody()).toBe(false);
  });

  it("strips the query string from page", async () => {
    vi.stubGlobal("location", { pathname: "/today?source=qr" });
    const { sendFeedback: fresh } = await import("./feedback.js");
    await fresh({ message: "hi" });
    expect(lastBody().page).toBe("/today");
  });

  it("correlates with error reports via the shared distinct-id key", async () => {
    storage["gnp:distinct-id"] = "same-device";
    await sendFeedback({ message: "hi" });
    expect(lastBody().id).toBe("same-device");
    expect(storage["gnp:distinct-id"]).toBe("same-device");
  });

  it("mints + persists a distinct id when storage is empty", async () => {
    await sendFeedback({ message: "hi" });
    expect(lastBody().id).toBe("uuid-1");
    expect(storage["gnp:distinct-id"]).toBe("uuid-1");
  });

  it("still sends when localStorage is unavailable (fresh id, no persist)", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const { sendFeedback: fresh } = await import("./feedback.js");
    await fresh({ message: "hi" });
    expect(lastBody().id).toBe("uuid-1");
  });
});