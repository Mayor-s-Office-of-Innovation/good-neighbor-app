import { beforeEach, expect, it, vi } from "vitest";
vi.mock("./api.js", () => ({ listChecks: vi.fn() }));
import { listChecks } from "./api.js";
import { loadStartingGuidance } from "./capture-guidance.js";
beforeEach(() => vi.resetAllMocks());
it("follows pagination and counts completion even for an old start", async () => {
  const completed = {
    status: "completed",
    startedAt: "2026-09-01T00:00:00Z",
    completedAt: "2026-10-13T18:00:00Z",
  };
  vi.mocked(listChecks)
    .mockResolvedValueOnce({ checks: [completed], nextToken: "page2" })
    .mockResolvedValueOnce({ checks: [completed] });
  expect(
    await loadStartingGuidance({
      id: "new",
      startedAt: "2026-10-13T19:00:00Z",
    }),
  ).toEqual({ titleKey: "check.title.third" });
  expect(listChecks).toHaveBeenNthCalledWith(2, {
    limit: 100,
    nextToken: "page2",
  });
});
