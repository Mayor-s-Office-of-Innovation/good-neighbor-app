import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildLatestProjection } = vi.hoisted(() => ({
  buildLatestProjection: vi.fn(),
}));
vi.mock("../reporting/publish-projection.js", () => ({
  buildLatestProjection,
}));

const { handler } = await import("./analytics-projection.js");

describe("analytics-projection lambda", () => {
  beforeEach(() => {
    buildLatestProjection.mockReset();
  });

  it("returns where it published the snapshot", async () => {
    const published = { prefix: "projections/1/snap", snapshotId: "snap" };
    buildLatestProjection.mockResolvedValue(published);
    await expect(handler()).resolves.toEqual(published);
  });

  it("rethrows a failed build, so Lambda records the error and retries it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    buildLatestProjection.mockRejectedValue(new Error("lake unreadable"));
    await expect(handler()).rejects.toThrow("lake unreadable");
    expect(String(error.mock.calls[0])).toContain("analytics-projection");
  });
});
