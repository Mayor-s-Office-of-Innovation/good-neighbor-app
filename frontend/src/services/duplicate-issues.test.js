import { invalidateDuplicateIssues } from "./duplicate-invalidation.js";
import { setDuplicateUiSite } from "./feature-flags.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getDuplicateLinks: vi.fn() }));
vi.mock("./api.js", () => api);
vi.mock("../db.js", () => ({
  getSite: vi.fn(async () => ({ siteId: "site-1" })),
}));
import { watchDuplicateIssues } from "./duplicate-issues.js";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { hidden: false });
  api.getDuplicateLinks.mockReset();
});
afterEach(() => {
  setDuplicateUiSite(null);
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
  await vi.advanceTimersByTimeAsync(0);
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

beforeEach(() =>
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } }),
);

it("does not poll when display is disabled and cancels in-flight publication when disabled", async () => {
  setDuplicateUiSite(null);
  const changed = vi.fn();
  watchDuplicateIssues(["one"], changed);
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.getDuplicateLinks).not.toHaveBeenCalled();
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } });
  /** @type {(value:any)=>void} */ let resolve = () => {};
  api.getDuplicateLinks.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const stop = watchDuplicateIssues(["one"], changed);
  await vi.advanceTimersByTimeAsync(0);
  setDuplicateUiSite(null);
  resolve({ enabled: true, issues: [{ taskId: "one", state: "matched" }] });
  await vi.advanceTimersByTimeAsync(30000);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0].size).toBe(0);
  stop();
});

it("replaces a stuck spinner when polling expires and preserves confirmed results", async () => {
  api.getDuplicateLinks.mockResolvedValue({
    enabled: true,
    issues: [
      { taskId: "one", state: "pending" },
      { taskId: "two", state: "matched" },
    ],
  });
  const changed = vi.fn();
  const stop = watchDuplicateIssues(["one", "two"], changed);
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
  const last = changed.mock.calls.at(-1)[0];
  expect(last.get("one").state).toBe("unavailable");
  expect(last.get("two").state).toBe("matched");
  const calls = api.getDuplicateLinks.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(calls);
  stop();
});

it("shares overlapping home and photo subscriptions and keeps cancellation independent", async () => {
  api.getDuplicateLinks.mockImplementation(async (ids) => ({
    enabled: true,
    issues: ids.map((taskId) => ({ taskId, state: "pending" })),
  }));
  const home = vi.fn(),
    photo = vi.fn();
  const stopHome = watchDuplicateIssues(["one", "two", "one"], home);
  const stopPhoto = watchDuplicateIssues(["two", "three"], photo);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(1);
  expect(api.getDuplicateLinks).toHaveBeenLastCalledWith(
    ["one", "two", "three"],
    expect.objectContaining({ originSiteId: "site-1" }),
  );
  expect([...home.mock.calls[0][0].keys()]).toEqual(["one", "two"]);
  expect([...photo.mock.calls[0][0].keys()]).toEqual(["two", "three"]);
  stopHome();
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.getDuplicateLinks).toHaveBeenLastCalledWith(
    ["two", "three"],
    expect.objectContaining({ originSiteId: "site-1" }),
  );
  expect(home).toHaveBeenCalledOnce();
  stopPhoto();
});

it("joins an in-flight batch without repeating it and reads only newly requested IDs", async () => {
  /** @type {(value: any) => void} */
  let respond = () => {};
  api.getDuplicateLinks
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    )
    .mockImplementation(async (ids) => ({
      enabled: true,
      issues: ids.map((taskId) => ({ taskId, state: "pending" })),
    }));
  const first = vi.fn(),
    second = vi.fn();
  const stopFirst = watchDuplicateIssues(["one"], first);
  await vi.advanceTimersByTimeAsync(0);
  const stopSecond = watchDuplicateIssues(["one", "two"], second);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
  respond({ enabled: true, issues: [{ taskId: "one", state: "pending" }] });
  await vi.advanceTimersByTimeAsync(1);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(2);
  expect(api.getDuplicateLinks.mock.calls[1][0]).toEqual(["two"]);
  expect([...second.mock.calls.at(-1)[0].keys()]).toEqual(["one", "two"]);
  stopFirst();
  stopSecond();
});

it("caps shared batches at 50 unique IDs", async () => {
  api.getDuplicateLinks.mockImplementation(async (ids) => ({
    enabled: true,
    issues: ids.map((taskId) => ({ taskId, state: "matched" })),
  }));
  const ids = Array.from({ length: 75 }, (_, i) => String(i));
  const stopA = watchDuplicateIssues(ids.slice(0, 50), vi.fn());
  const stopB = watchDuplicateIssues(ids.slice(25), vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(
    api.getDuplicateLinks.mock.calls.map(([batch]) => batch.length),
  ).toEqual([50, 25]);
  expect(api.getDuplicateLinks.mock.calls.flatMap(([batch]) => batch)).toEqual(
    ids,
  );
  stopA();
  stopB();
});

it("discards old-site results even when duplicate detection is enabled at both sites", async () => {
  const { getSite } = await import("../db.js");
  /** @type {(value: any) => void} */
  let respond = () => {};
  api.getDuplicateLinks.mockImplementation(
    () =>
      new Promise((resolve) => {
        respond = resolve;
      }),
  );
  const changed = vi.fn();
  const stop = watchDuplicateIssues(["one"], changed);
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(getSite).mockResolvedValueOnce({ siteId: "site-2" });
  respond({ enabled: true, issues: [{ taskId: "one", state: "matched" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).toHaveBeenCalledOnce();
  expect(changed.mock.calls[0][0].size).toBe(0);
  await vi.advanceTimersByTimeAsync(30000);
  expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
  stop();
});

it("expires subscribers independently without stopping a newer subscriber", async () => {
  api.getDuplicateLinks.mockResolvedValue({
    enabled: true,
    issues: [{ taskId: "one", state: "pending" }],
  });
  const first = vi.fn(),
    second = vi.fn();
  const stopFirst = watchDuplicateIssues(["one"], first);
  await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
  const stopSecond = watchDuplicateIssues(["one"], second);
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(first.mock.calls.at(-1)[0].get("one").state).toBe("unavailable");
  expect(second.mock.calls.at(-1)[0].get("one").state).toBe("pending");
  const calls = api.getDuplicateLinks.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(calls + 1);
  stopFirst();
  stopSecond();
});

it("shares error backoff without publishing a failed read as an empty result", async () => {
  api.getDuplicateLinks
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue({
      enabled: true,
      issues: [{ taskId: "one", state: "matched" }],
    });
  const first = vi.fn(),
    second = vi.fn();
  const stopFirst = watchDuplicateIssues(["one"], first);
  const stopSecond = watchDuplicateIssues(["one"], second);
  await vi.advanceTimersByTimeAsync(14999);
  expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(2);
  expect(first.mock.calls[0][0].get("one").state).toBe("matched");
  expect(second.mock.calls[0][0].get("one").state).toBe("matched");
  await vi.advanceTimersByTimeAsync(29999);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(2);
  stopFirst();
  stopSecond();
});

it("invalidates cached matches and ignores pre-separation responses with home still subscribed", async () => {
  const matched = {
    taskId: "one",
    state: "matched",
    original: { taskId: "old" },
  };
  api.getDuplicateLinks.mockResolvedValueOnce({
    enabled: true,
    issues: [matched],
  });
  const home = vi.fn(),
    photo = vi.fn();
  const stopHome = watchDuplicateIssues(["one"], home);
  await vi.advanceTimersByTimeAsync(0);
  /** @type {(value: any) => void} */
  let respond = () => {};
  api.getDuplicateLinks
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValue({
      enabled: true,
      issues: [{ taskId: "one", state: "pending" }],
    });
  await vi.advanceTimersByTimeAsync(30000);
  invalidateDuplicateIssues();
  const stopPhoto = watchDuplicateIssues(["one"], photo);
  respond({ enabled: true, issues: [matched] });
  await vi.advanceTimersByTimeAsync(1);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(3);
  expect(home.mock.calls.at(-1)[0].get("one").state).toBe("pending");
  expect(
    photo.mock.calls.every(([links]) => links.get("one").state === "pending"),
  ).toBe(true);
  stopHome();
  stopPhoto();
});

it("bounds a stalled request so a newly requested task can make progress", async () => {
  /** @type {(value: any) => void} */
  let respond = () => {};
  api.getDuplicateLinks
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    )
    .mockResolvedValue({
      enabled: true,
      issues: [{ taskId: "two", state: "matched" }],
    });
  const first = vi.fn(),
    second = vi.fn();
  const stopFirst = watchDuplicateIssues(["one"], first);
  await vi.advanceTimersByTimeAsync(0);
  const signal = api.getDuplicateLinks.mock.calls[0][1].signal;
  const stopSecond = watchDuplicateIssues(["two"], second);
  await vi.advanceTimersByTimeAsync(10001);
  expect(signal.aborted).toBe(true);
  expect(api.getDuplicateLinks.mock.calls[1][0]).toEqual(["two"]);
  expect(second.mock.calls.at(-1)[0].get("two").state).toBe("matched");
  respond({ enabled: true, issues: [{ taskId: "one", state: "matched" }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(first).not.toHaveBeenCalled();
  stopFirst();
  stopSecond();
});

it("expires on time while a request is pending", async () => {
  api.getDuplicateLinks.mockResolvedValue({
    enabled: true,
    issues: [{ taskId: "one", state: "pending" }],
  });
  const changed = vi.fn();
  const stop = watchDuplicateIssues(["one"], changed);
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 6000);
  api.getDuplicateLinks.mockImplementation(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(6000);
  expect(changed.mock.calls.at(-1)[0].get("one").state).toBe("unavailable");
  const calls = api.getDuplicateLinks.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30000);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(calls);
  stop();
});

it("preserves the displayed map until all requested batches have results", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => String(i));
  const matched = {
    taskId: "50",
    state: "matched",
    original: { taskId: "old" },
  };
  let displayed = new Map([["50", matched]]);
  const changed = vi.fn((links) => {
    displayed = links;
  });
  api.getDuplicateLinks
    .mockResolvedValueOnce({
      enabled: true,
      issues: ids.slice(0, 50).map((taskId) => ({ taskId, state: "pending" })),
    })
    .mockRejectedValueOnce(new Error("second batch failed"))
    .mockImplementation(async (batch) => ({
      enabled: true,
      issues: batch.map((taskId) =>
        taskId === "50" ? matched : { taskId, state: "pending" },
      ),
    }));
  const stop = watchDuplicateIssues(ids, changed);
  await vi.advanceTimersByTimeAsync(0);
  expect(changed).not.toHaveBeenCalled();
  expect(displayed.get("50")).toEqual(matched);
  await vi.advanceTimersByTimeAsync(15000);
  expect(changed).toHaveBeenCalled();
  expect(displayed.size).toBe(51);
  expect(displayed.get("50")).toEqual(matched);
  stop();
});

it("aborts the last watcher's request before its replacement starts", async () => {
  let inFlight = 0;
  let maximum = 0;
  api.getDuplicateLinks.mockImplementation(
    (ids, { signal }) =>
      new Promise((resolve, reject) => {
        inFlight++;
        maximum = Math.max(maximum, inFlight);
        signal.addEventListener(
          "abort",
          () => {
            inFlight--;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  const old = vi.fn(),
    replacement = vi.fn();
  const stopOld = watchDuplicateIssues(["one"], old);
  await vi.advanceTimersByTimeAsync(0);
  const oldSignal = api.getDuplicateLinks.mock.calls[0][1].signal;
  stopOld();
  expect(oldSignal.aborted).toBe(true);
  const stopReplacement = watchDuplicateIssues(["one"], replacement);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.getDuplicateLinks).toHaveBeenCalledTimes(2);
  expect(maximum).toBe(1);
  expect(old).not.toHaveBeenCalled();
  expect(replacement).not.toHaveBeenCalled();
  stopReplacement();
  expect(inFlight).toBe(0);
});

it("pauses all batches and new subscriptions for the server cooldown", async () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  api.getDuplicateLinks
    .mockRejectedValueOnce({ status: 429, retryAfterMs: 300000 })
    .mockResolvedValue({ enabled: true, issues: [] });
  const stop = watchDuplicateIssues(
    Array.from({ length: 101 }, (_, i) => `task-${i}`),
    vi.fn(),
  );
  let stopNew;
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
    stopNew = watchDuplicateIssues(["new-task"], vi.fn());
    invalidateDuplicateIssues();
    await vi.advanceTimersByTimeAsync(299999);
    expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.getDuplicateLinks).toHaveBeenCalledTimes(4);
  } finally {
    stop();
    stopNew?.();
    random.mockRestore();
  }
});

it("uses a conservative cooldown when throttling has no retry advice and expires subscribers", async () => {
  api.getDuplicateLinks.mockRejectedValue({ status: 429 });
  const stop = watchDuplicateIssues(["one"], vi.fn());
  try {
    await vi.advanceTimersByTimeAsync(299999);
    expect(api.getDuplicateLinks).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(610001);
    const calls = api.getDuplicateLinks.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600000);
    expect(api.getDuplicateLinks).toHaveBeenCalledTimes(calls);
  } finally {
    stop();
  }
});
