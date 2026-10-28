import { afterEach, expect, it, vi } from "vitest";
vi.mock("./analytics.js", () => ({
  trackEvent: vi.fn().mockResolvedValue(true),
}));
import { trackEvent } from "./analytics.js";
import { observePhotoStage } from "./photo-telemetry.js";
const context = {
  check_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
};
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("reports a stalled stage once, then completion without altering the result", async () => {
  vi.useFakeTimers();
  /** @type {(value: string) => void} */
  let finish = () => {
    throw new Error("Stage did not start");
  };
  const result = observePhotoStage(
    "put",
    context,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await vi.advanceTimersByTimeAsync(90_000);
  expect(vi.mocked(trackEvent).mock.calls.map((c) => c[1].outcome)).toEqual([
    "started",
    "slow",
  ]);
  finish("uploaded");
  await expect(result).resolves.toBe("uploaded");
  expect(trackEvent).toHaveBeenLastCalledWith(
    "photo_pipeline",
    expect.objectContaining({
      stage: "put",
      outcome: "completed",
      elapsed_ms: 90000,
      ...context,
    }),
  );
  expect(vi.getTimerCount()).toBe(0);
});
it("reports caught failures without exposing messages or signed URLs", async () => {
  const error = Object.assign(
    new Error("https://example.test?signature=PRIVATE"),
    { status: 403 },
  );
  await expect(
    observePhotoStage("put", context, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(trackEvent).toHaveBeenLastCalledWith(
    "photo_pipeline",
    expect.objectContaining({ outcome: "failed", http_status: 403 }),
  );
  expect(JSON.stringify(vi.mocked(trackEvent).mock.calls)).not.toContain(
    "PRIVATE",
  );
});
it("distinguishes polling timeout and backend failure", async () => {
  await expect(
    observePhotoStage("analyze", context, async () => {
      throw { body: { code: "analyses_pending" } };
    }),
  ).rejects.toBeDefined();
  expect(trackEvent).toHaveBeenLastCalledWith(
    "photo_pipeline",
    expect.objectContaining({ outcome: "timeout" }),
  );
  await observePhotoStage("analyze", context, async () => ({
    status: "failed",
  }));
  expect(trackEvent).toHaveBeenLastCalledWith(
    "photo_pipeline",
    expect.objectContaining({ outcome: "backend_failed" }),
  );
});
it("does not let telemetry failures change application results", async () => {
  vi.mocked(trackEvent).mockRejectedValueOnce(new Error("offline"));
  await expect(
    observePhotoStage("register", context, async () => 42),
  ).resolves.toBe(42);
});
