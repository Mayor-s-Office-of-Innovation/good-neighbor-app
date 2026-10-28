import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getTaskDetails: vi.fn() }));
vi.mock("./api.js", () => api);
import { watchQueued311Filings } from "./queued-311-filings.js";

/**
 * @param {string} taskId
 * @param {string} appActionStatus
 */
const task = (taskId, appActionStatus) => ({
  clicked: {
    taskId,
    status: "in_progress",
    inProgressActionKind: "311_filed",
    appActionStatus,
  },
});

/** A stand-in document whose visibility the test can flip. */
function stubDocument(hidden = false) {
  const listeners = new Set();
  const doc = {
    hidden,
    addEventListener: vi.fn((_type, listener) => listeners.add(listener)),
    removeEventListener: vi.fn((_type, listener) => listeners.delete(listener)),
    /** @param {boolean} value */
    setHidden(value) {
      doc.hidden = value;
      listeners.forEach((listener) => listener());
    },
    listeners,
  };
  vi.stubGlobal("document", doc);
  return doc;
}

beforeEach(() => {
  vi.useFakeTimers();
  stubDocument();
  api.getTaskDetails.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reports each filing once, when it leaves the queue", async () => {
  api.getTaskDetails.mockImplementation(async (id) =>
    task(id, id === "one" ? "submitted" : "queued"),
  );
  const onSettled = vi.fn();
  const stop = watchQueued311Filings(["one", "two"], onSettled);

  await vi.advanceTimersByTimeAsync(3000);
  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(onSettled.mock.calls[0][0]).toMatchObject({ taskId: "one" });

  api.getTaskDetails.mockImplementation(async (id) => task(id, "failed"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(onSettled).toHaveBeenCalledTimes(2);
  expect(onSettled.mock.calls[1][0]).toMatchObject({ taskId: "two" });
  // Only "two" was still being watched.
  expect(api.getTaskDetails).toHaveBeenLastCalledWith("two", {
    signal: expect.any(AbortSignal),
  });

  await vi.advanceTimersByTimeAsync(60_000);
  expect(onSettled).toHaveBeenCalledTimes(2);
  stop();
});

it("doesn't count hidden time, and checks as soon as the page is visible", async () => {
  const doc = stubDocument(true);
  api.getTaskDetails.mockResolvedValue(task("one", "submitted"));
  const onSettled = vi.fn();
  const stop = watchQueued311Filings(["one"], onSettled);

  // Well past the visible-time budget, all of it hidden.
  await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
  expect(api.getTaskDetails).not.toHaveBeenCalled();

  doc.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(onSettled).toHaveBeenCalledTimes(1);
  stop();
});

it("keeps going after errors", async () => {
  api.getTaskDetails
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(task("one", "submitted"));
  const onSettled = vi.fn();
  const stop = watchQueued311Filings(["one"], onSettled);

  await vi.advanceTimersByTimeAsync(3000);
  expect(onSettled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(onSettled).toHaveBeenCalledTimes(1);
  stop();
});

it("checks every card at once and gives up on a stalled request", async () => {
  /** @type {AbortSignal | undefined} */
  let stalled;
  api.getTaskDetails.mockImplementation((id, { signal }) => {
    if (id === "two") return Promise.resolve(task(id, "submitted"));
    stalled = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  });
  const onSettled = vi.fn();
  const stop = watchQueued311Filings(["one", "two"], onSettled);

  await vi.advanceTimersByTimeAsync(3000);
  expect(onSettled).toHaveBeenCalledTimes(1);
  expect(onSettled.mock.calls[0][0]).toMatchObject({ taskId: "two" });
  expect(stalled?.aborted).toBe(false);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(stalled?.aborted).toBe(true);
  stop();
});

it("cancels the request in flight when stopped", async () => {
  /** @type {AbortSignal | undefined} */
  let inFlight;
  api.getTaskDetails.mockImplementation((_id, { signal }) => {
    inFlight = signal;
    return new Promise(() => {});
  });
  const doc = stubDocument();
  const stop = watchQueued311Filings(["one"], vi.fn());
  await vi.advanceTimersByTimeAsync(3000);

  stop();
  expect(inFlight?.aborted).toBe(true);
  expect(doc.listeners.size).toBe(0);
});

it("stops after its visible-time budget", async () => {
  api.getTaskDetails.mockResolvedValue(task("one", "queued"));
  const doc = stubDocument();
  watchQueued311Filings(["one"], vi.fn());

  await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
  expect(api.getTaskDetails).toHaveBeenCalledTimes(48);
  expect(doc.listeners.size).toBe(0);
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(api.getTaskDetails).toHaveBeenCalledTimes(48);
});
