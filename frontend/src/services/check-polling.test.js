import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pollCheck, cancelCheckPolling } from "./check-polling.js";
import { getSite } from "../db.js";
vi.mock("../db.js", () => ({ getSite: vi.fn() }));
const snapshot = (ids = []) => ({
  check: {},
  artifacts: [],
  analyses: ids.map((artifactId) => ({ artifactId })),
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getSite).mockResolvedValue({ siteId: "site-a" });
});
afterEach(() => {
  cancelCheckPolling("check");
  cancelCheckPolling("other");
  vi.useRealTimers();
});

it("shares one read stream across four photos and finalization, including a late subscriber", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValueOnce(snapshot(["a"]))
    .mockResolvedValue(snapshot(["a", "b", "c", "d"]));
  const photos = ["a", "b", "c", "d"].map((id) =>
    pollCheck("check", read, (s) =>
      s.analyses.find((a) => a.artifactId === id),
    ),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  const final = pollCheck("check", read, (s) =>
    s.analyses.length === 4 ? s : undefined,
  );
  await vi.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(2);
  await expect(photos[0]).resolves.toEqual({ artifactId: "a" });
  await vi.advanceTimersByTimeAsync(2000);
  await Promise.all([...photos, final]);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(3);
});

it("a consumer timeout does not stop the remaining consumer", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(snapshot())
    .mockResolvedValue(snapshot(["a"]));
  const short = pollCheck("check", read, () => {
    throw new Error("consumer deadline");
  }).catch((error) => error);
  const long = pollCheck("check", read, (s) => s.analyses[0]);
  await vi.advanceTimersByTimeAsync(0);
  expect((await short).message).toBe("consumer deadline");
  await vi.advanceTimersByTimeAsync(2000);
  await expect(long).resolves.toEqual({ artifactId: "a" });
  expect(read).toHaveBeenCalledTimes(2);
});

it("cancels an in-flight check without delivering its late result or stopping another check", async () => {
  /** @type {(value: import("./check-polling.js").CheckSnapshot) => void} */
  let release = () => {};
  const read = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const inspect = vi.fn((s) => s);
  const waiting = pollCheck("check", read, inspect).catch((error) => error);
  const otherRead = vi.fn().mockResolvedValue(snapshot());
  const other = pollCheck("other", otherRead, (s) => s);
  await vi.advanceTimersByTimeAsync(0);
  cancelCheckPolling("check");
  expect((await waiting).name).toBe("AbortError");
  expect(read).toHaveBeenCalledWith(
    "check",
    expect.objectContaining({
      signal: expect.objectContaining({ aborted: true }),
    }),
  );
  release(snapshot(["a"]));
  await vi.advanceTimersByTimeAsync(4000);
  expect(inspect).not.toHaveBeenCalled();
  await expect(other).resolves.toEqual(snapshot());
  expect(read).toHaveBeenCalledTimes(1);
});

it("shares a request failure and starts a fresh read on a later retry", async () => {
  const error = new Error("network failure");
  const read = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(snapshot());
  const first = pollCheck("check", read, (s) => s).catch((e) => e);
  const second = pollCheck("check", read, (s) => s).catch((e) => e);
  expect(await first).toBe(error);
  expect(await second).toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
  await expect(pollCheck("check", read, (s) => s)).resolves.toEqual(snapshot());
  expect(read).toHaveBeenCalledTimes(2);
});

it("rejects a late result after the active site changes", async () => {
  /** @type {(value: import("./check-polling.js").CheckSnapshot) => void} */
  let release = () => {};
  const read = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const inspect = vi.fn((s) => s);
  const waiting = pollCheck("check", read, inspect).catch((error) => error);
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(getSite).mockResolvedValue({ siteId: "site-b" });
  release(snapshot());
  expect((await waiting).name).toBe("AbortError");
  expect(inspect).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledWith(
    "check",
    expect.objectContaining({ originSiteId: "site-a" }),
  );
});
