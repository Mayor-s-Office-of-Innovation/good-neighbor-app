import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getDuplicateLinks: vi.fn() }));
vi.mock("./api.js", () => api);
import { watchDuplicateIssues } from "./duplicate-issues.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { hidden: false });
  api.getDuplicateLinks.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("publishes incremental results without waiting for all issues", async () => {
  api.getDuplicateLinks
    .mockResolvedValueOnce({
      enabled: true,
      issues: [
        { taskId: "one", state: "pending" },
        { taskId: "two", state: "pending" },
      ],
    })
    .mockResolvedValue({
      enabled: true,
      issues: [
        { taskId: "one", state: "matched", original: { taskId: "old" } },
        { taskId: "two", state: "pending" },
      ],
    });
  const changed = vi.fn(),
    stop = watchDuplicateIssues(["one", "two"], changed);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(changed.mock.calls[1][0].get("one").state).toBe("matched");
  stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(2);
});
it("ignores a late response after navigation and pauses hidden screens", async () => {
  /** @type {(value:any)=>void} */ let resolve = () => {};
  api.getDuplicateLinks.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const changed = vi.fn(),
    stop = watchDuplicateIssues(["one"], changed);
  stop();
  resolve({ enabled: true, issues: [{ taskId: "one", state: "matched" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).not.toHaveBeenCalled();
  vi.stubGlobal("document", { hidden: true });
  const stopHidden = watchDuplicateIssues(["two"], changed);
  await vi.advanceTimersByTimeAsync(4000);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(1);
  stopHidden();
});
it("a disabled detector clears transient UI results without repeated requests", async () => {
  api.getDuplicateLinks.mockResolvedValue({ enabled: false, issues: [] });
  const changed = vi.fn();
  watchDuplicateIssues(["one"], changed);
  await vi.advanceTimersByTimeAsync(10000);
  expect(changed.mock.calls[0][0].size).toBe(0);
  expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
});
