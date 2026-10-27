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

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { hidden: false });
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
  expect(api.getTaskDetails).toHaveBeenLastCalledWith("two");

  await vi.advanceTimersByTimeAsync(60_000);
  expect(onSettled).toHaveBeenCalledTimes(2);
  stop();
});

it("skips polls while the page is hidden and keeps going after errors", async () => {
  vi.stubGlobal("document", { hidden: true });
  api.getTaskDetails.mockResolvedValue(task("one", "submitted"));
  const onSettled = vi.fn();
  const stop = watchQueued311Filings(["one"], onSettled);

  await vi.advanceTimersByTimeAsync(3000);
  expect(api.getTaskDetails).not.toHaveBeenCalled();

  vi.stubGlobal("document", { hidden: false });
  api.getTaskDetails.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(onSettled).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(15_000);
  expect(onSettled).toHaveBeenCalledTimes(1);
  stop();
});

it("stops on request and after ten minutes", async () => {
  api.getTaskDetails.mockResolvedValue(task("one", "queued"));
  const stop = watchQueued311Filings(["one"], vi.fn());
  await vi.advanceTimersByTimeAsync(3000);
  stop();
  const calls = api.getTaskDetails.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.getTaskDetails).toHaveBeenCalledTimes(calls);

  api.getTaskDetails.mockClear();
  watchQueued311Filings(["one"], vi.fn());
  await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
  const total = api.getTaskDetails.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  expect(api.getTaskDetails).toHaveBeenCalledTimes(total);
});
