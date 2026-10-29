import { beforeEach, afterEach, expect, test, vi } from "vitest";
let state;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn());
  state = await import("./connection-state.js");
});
afterEach(() => vi.unstubAllGlobals());
test("HTTP validation, auth, throttling and server errors remain operation errors", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));
    await state.connectionFetch("https://example.test/v1/tasks");
    expect(state.connectionSnapshot().disconnected).toBe(false);
  }
});
test("transport failures deduplicate and browser online alone cannot clear them", async () => {
  const changes = vi.fn();
  state.onConnectionChange(changes);
  vi.mocked(fetch).mockRejectedValue(new TypeError("network"));
  await expect(
    state.connectionFetch("https://example.test/v1/tasks"),
  ).rejects.toThrow();
  await expect(
    state.connectionFetch("https://example.test/v1/tasks"),
  ).rejects.toThrow();
  expect(changes).toHaveBeenCalledTimes(1);
  await state.retryConnection();
  expect(state.connectionSnapshot().disconnected).toBe(true);
});
test("API probe cannot clear a failed upload host and never replays a write", async () => {
  state.connectionFailed(
    "api:https://example.test",
    "https://example.test/health",
  );
  const upload = state.connectionTarget(
    "https://uploads.example.test/file?signature=synthetic",
  );
  expect(upload).toEqual({
    service: "upload:https://uploads.example.test",
    probeUrl: "https://uploads.example.test/",
  });
  state.connectionFailed(upload.service);
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: true })),
  );
  await state.retryConnection();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(fetch).mock.calls[0][1].method).toBeUndefined();
  expect(state.connectionSnapshot().disconnected).toBe(true);
  await state.connectionFetch("https://uploads.example.test/file", {
    method: "PUT",
  });
  expect(state.connectionSnapshot().disconnected).toBe(false);
});
test("caller cancellation is not loss of connectivity", async () => {
  const controller = new AbortController();
  controller.abort();
  vi.mocked(fetch).mockRejectedValue(
    new DOMException("cancelled", "AbortError"),
  );
  await expect(
    state.connectionFetch("https://example.test/v1/tasks", {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(state.connectionSnapshot().disconnected).toBe(false);
});
test("recovery honors Retry-After instead of hammering a throttled probe", async () => {
  state.connectionFailed("api", "/health");
  vi.mocked(fetch).mockResolvedValue(
    new Response(null, { status: 429, headers: { "Retry-After": "300" } }),
  );
  await state.retryConnection();
  await state.retryConnection();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(state.connectionSnapshot().disconnected).toBe(true);
});

test("manual retry and loopback successes cannot clear browser offline", async () => {
  vi.stubGlobal("navigator", { onLine: false });
  state.connectionFailed("browser", "http://localhost/health");
  state.connectionFailed("api:http://localhost", "http://localhost/health");
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: true })),
  );
  await state.retryConnection();
  expect(fetch).not.toHaveBeenCalled();
  await state.connectionFetch("http://localhost/v1/tasks");
  state.connectionSucceeded("browser");
  expect(state.connectionSnapshot().disconnected).toBe(true);
  vi.stubGlobal("navigator", { onLine: true });
  vi.mocked(fetch).mockImplementation(
    async () => new Response(JSON.stringify({ ok: true })),
  );
  await state.retryConnection();
  expect(state.connectionSnapshot().disconnected).toBe(false);
});

test("a probe started before a new failure cannot announce recovery", async () => {
  /** @type {(response: Response) => void} */
  let resolve = () => {};
  state.connectionFailed("api", "/health");
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = state.retryConnection();
  state.connectionFailed("api", "/health");
  resolve(new Response(JSON.stringify({ ok: true })));
  await pending;
  expect(state.connectionSnapshot().disconnected).toBe(true);
});

test("an HTML fallback is not a successful health probe", async () => {
  state.connectionFailed("api", "/health");
  vi.mocked(fetch).mockResolvedValue(
    new Response("<!doctype html><html></html>"),
  );
  await state.retryConnection();
  expect(state.connectionSnapshot().disconnected).toBe(true);
});

test("auth and upload probes use only credential-free host GETs", async () => {
  for (const url of [
    "https://login.test/oauth2/token",
    "https://uploads.test/object?signature=secret",
  ]) {
    const target = state.connectionTarget(url);
    state.connectionFailed(target.service, target.probeUrl);
  }
  vi.mocked(fetch).mockResolvedValue(
    Object.defineProperty(new Response(), "type", { value: "opaque" }),
  );
  await state.retryConnection();
  expect(state.connectionSnapshot().disconnected).toBe(false);
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
    "https://login.test/",
    "https://uploads.test/",
  ]);
  for (const [, options] of vi.mocked(fetch).mock.calls) {
    expect(options).toMatchObject({
      mode: "no-cors",
      credentials: "omit",
      redirect: "follow",
      cache: "no-store",
    });
    expect(options.body).toBeUndefined();
    expect(options.headers).toBeUndefined();
  }
});

test("failed API or upload probes cannot wake queues; unrelated auth does not block recovery", async () => {
  const dispatchEvent = vi.fn();
  vi.stubGlobal("window", { dispatchEvent });
  state.connectionFailed("api:field", "/health");
  state.connectionFailed(
    "upload:https://uploads.test",
    "https://uploads.test/",
  );
  state.connectionFailed("auth:https://login.test", "https://login.test/");
  vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
  await state.retryConnection();
  expect(dispatchEvent).not.toHaveBeenCalled();
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === "/health") return new Response(JSON.stringify({ ok: true }));
    throw new TypeError("offline");
  });
  await state.retryConnection();
  expect(dispatchEvent).not.toHaveBeenCalled();
  vi.mocked(fetch).mockImplementation(async (url) => {
    if (url === "https://uploads.test/")
      return Object.defineProperty(new Response(), "type", { value: "opaque" });
    throw new TypeError("offline");
  });
  await state.retryConnection();
  expect(dispatchEvent).toHaveBeenCalledTimes(1);
  expect(state.connectionSnapshot().disconnected).toBe(true);
});
