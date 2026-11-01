import { afterEach, expect, it, vi } from "vitest";
vi.mock("./backend-health.js", () => ({ getHealthState: () => "healthy" }));
import {
  AUTO_RETRIES,
  canManuallyRetry,
  failedRecovery,
  withUploadSlot,
} from "./evidence-recovery.js";
afterEach(() => vi.unstubAllGlobals());
it("persists a finite budget, honors Retry-After, and survives serialization", () => {
  let recovery;
  for (let attempt = 0; attempt < AUTO_RETRIES; attempt++) {
    recovery = JSON.parse(
      JSON.stringify(
        failedRecovery(recovery, "upload", {
          status: 429,
          retryAfterMs: 60_000,
        }),
      ),
    );
    expect(recovery.nextAttemptAt).toBeGreaterThanOrEqual(Date.now() + 59_900);
    expect(recovery.state).toBe("scheduled");
  }
  recovery = failedRecovery(recovery, "upload", { status: 503 });
  expect(recovery.state).toBe("manual");
  expect(failedRecovery(recovery, "evaluate", { status: 503 }).state).toBe(
    "scheduled",
  );
});
it("only offers a retry for an idle failed operation with a usable connection", () => {
  const item = {
    analysis: { status: "failed", recovery: { state: "manual" } },
  };
  vi.stubGlobal("navigator", { onLine: false });
  expect(canManuallyRetry(item)).toBe(false);
  vi.stubGlobal("navigator", { onLine: true });
  expect(canManuallyRetry(item)).toBe(true);
  expect(canManuallyRetry({ analysis: { status: "failed" } })).toBe(false);
  item.analysis.recovery.state = "working";
  expect(canManuallyRetry(item)).toBe(false);
  item.analysis.recovery.state = "blocked";
  expect(canManuallyRetry(item)).toBe(false);
});
it("caps transfers at two, preserves FIFO order, and releases slots on failure", async () => {
  vi.stubGlobal("navigator", { onLine: true });
  const started = [];
  const release = [];
  const jobs = [0, 1, 2, 3].map((id) =>
    withUploadSlot(async () => {
      started.push(id);
      await new Promise((resolve) => {
        release[id] = resolve;
      });
      if (id === 0) throw new Error("synthetic failure");
      return id;
    }),
  );
  const settled = Promise.allSettled(jobs);
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  release[0]();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  release[1]();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
  release[2]();
  release[3]();
  expect(
    (await settled).filter((result) => result.status === "fulfilled"),
  ).toHaveLength(3);
});
it("uses origin-wide Web Lock slots without blocking on an occupied first slot", async () => {
  const request = vi.fn(async (name, _options, work) =>
    work(name.endsWith(":0") ? null : {}),
  );
  vi.stubGlobal("navigator", { onLine: true, locks: { request } });
  expect(await withUploadSlot(async () => "done")).toBe("done");
  expect(request.mock.calls.map(([name]) => name)).toEqual([
    "check-upload:0",
    "check-upload:1",
  ]);
});
