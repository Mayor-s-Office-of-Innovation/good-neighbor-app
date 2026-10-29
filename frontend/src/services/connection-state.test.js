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
    probeUrl: "",
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
