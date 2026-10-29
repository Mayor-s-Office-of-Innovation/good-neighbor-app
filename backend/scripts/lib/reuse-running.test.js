import process from "node:process";
import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
import { alreadyRunning } from "./reuse-running.mjs";
afterEach(() => vi.restoreAllMocks());

it("waits through inconclusive startup probes until the service identifies itself", async () => {
  const probe = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("slow"), { name: "TimeoutError" }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    )
    .mockResolvedValueOnce({});
  expect(
    await alreadyRunning("ddb", 8000, probe, {
      timeoutMs: 100,
      retryDelayMs: 1,
    }),
  ).toBe(true);
  expect(probe).toHaveBeenCalledTimes(3);
});
it("reports an empty port without retrying", async () => {
  const probe = vi.fn().mockRejectedValue({ cause: { code: "ECONNREFUSED" } });
  expect(await alreadyRunning("ddb", 8000, probe)).toBe(false);
  expect(probe).toHaveBeenCalledOnce();
});
it.each([true, false])(
  "exits with an accurate diagnostic (timed out: %s)",
  async (timedOut) => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const probe = vi.fn().mockRejectedValue({
      name: timedOut ? "TimeoutError" : "InvalidResponse",
    });
    await expect(
      alreadyRunning("ddb", 8000, probe, { timeoutMs: 0 }),
    ).rejects.toThrow("exit");
    expect(log.mock.calls[0][0]).toContain(
      timedOut ? "did not become identifiable" : "held by something else",
    );
    expect(probe).toHaveBeenCalledOnce();
  },
);
