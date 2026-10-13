import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./api.js", () => ({ getCaptureGuidance: vi.fn() }));
import { getCaptureGuidance } from "./api.js";
import { loadStartingGuidance } from "./capture-guidance.js";
beforeEach(() => vi.resetAllMocks());
it("reads only the bounded counts, scoped to site and capture instant", async () => {
  vi.mocked(getCaptureGuidance).mockResolvedValue({ counts: [2, 0, 0, 0, 0] });
  const signal = new AbortController().signal;
  expect(
    await loadStartingGuidance(
      { id: "new", siteId: "site", startedAt: "2026-10-13T19:00:00Z" },
      signal,
    ),
  ).toEqual({ titleKey: "check.title.third" });
  expect(getCaptureGuidance).toHaveBeenCalledExactlyOnceWith({
    checkId: "new",
    siteId: "site",
    startedAt: "2026-10-13T19:00:00Z",
    signal,
  });
});
it("does not save a default when migration/history is unavailable", async () => {
  vi.mocked(getCaptureGuidance).mockRejectedValue(
    new Error("migration pending"),
  );
  await expect(
    loadStartingGuidance({ id: "new", startedAt: "2026-10-13T19:00:00Z" }),
  ).rejects.toThrow("migration pending");
});
it("rejects malformed counts rather than persisting an incorrect title", async () => {
  vi.mocked(getCaptureGuidance).mockResolvedValue({ counts: [2] });
  await expect(
    loadStartingGuidance({ id: "new", startedAt: "2026-10-13T19:00:00Z" }),
  ).rejects.toThrow("Invalid capture guidance counts");
});
