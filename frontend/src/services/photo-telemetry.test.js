import { afterEach, expect, it, vi } from "vitest";
vi.mock("./analytics.js", () => ({
  trackEvent: vi.fn().mockResolvedValue(true),
}));
import { trackEvent } from "./analytics.js";
import { observePhotoStage, photoAttemptId } from "./photo-telemetry.js";
const context = {
  check_id: "11111111-1111-4111-8111-111111111111",
  attempt_id: "22222222-2222-4222-8222-222222222222",
};
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

it.each([
  undefined,
  {},
  {
    randomUUID() {
      throw new Error("unavailable");
    },
  },
])(
  "generates UUID-shaped attempt IDs without a working UUID API (%s)",
  (cryptoApi) => {
    vi.stubGlobal("crypto", cryptoApi);
    expect(photoAttemptId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  },
);
it("uses random bytes when randomUUID throws", () => {
  const getRandomValues = vi.fn((bytes) => bytes.fill(1));
  vi.stubGlobal("crypto", {
    randomUUID() {
      throw new Error("denied");
    },
    getRandomValues,
  });
  expect(photoAttemptId()).toBe("01010101-0101-4101-8101-010101010101");
  expect(getRandomValues).toHaveBeenCalledOnce();
});
it("continues the stage even if every ID fallback fails", async () => {
  vi.stubGlobal("crypto", undefined);
  vi.spyOn(Math, "random").mockImplementation(() => {
    throw new Error("unavailable");
  });
  const attempt_id = photoAttemptId();
  expect(attempt_id).toBe("");
  await expect(
    observePhotoStage(
      "put",
      { ...context, attempt_id },
      async () => "uploaded",
    ),
  ).resolves.toBe("uploaded");
});
