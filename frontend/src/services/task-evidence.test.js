import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMediaUrl = vi.fn();
vi.mock("./api.js", () => ({
  getCheck: vi.fn(),
  getMediaUrl: (...args) => getMediaUrl(...args),
}));

const {
  hydrateTaskEvidenceFromCheck,
  cachedMediaUrls,
  needsTaskEvidenceHydration,
  invalidateMediaUrls,
  markMediaUnavailable,
} = await import("./task-evidence.js");

const detail = {
  artifacts: [
    {
      artifactId: "p1",
      s3Key: "k/p1.jpg",
      contentType: "image/jpeg",
      placeName: "",
    },
    { artifactId: "d1", text: "Sidewalk clear." },
  ],
  analyses: [{ artifactId: "p1", georeferencedAddress: "15th St" }],
};

describe("hydrateTaskEvidenceFromCheck", () => {
  beforeEach(() => {
    getMediaUrl.mockReset();
    getMediaUrl.mockResolvedValue({ downloadUrl: "https://media/p1" });
  });

  it("attaches the source artifact's street and the signed original", async () => {
    const [task] = await hydrateTaskEvidenceFromCheck(
      [{ taskId: "t1", checkId: "c1", sourceArtifactIds: ["p1"] }],
      detail,
    );
    expect(task.evidence).toEqual({
      artifactId: "p1",
      kind: "photo",
      placeName: "",
      georeferencedAddress: "15th St",
      text: "",
    });
    expect(task.mediaUrl).toBe("https://media/p1");
    expect(task.thumbnailUrl).toBeUndefined();
    expect(getMediaUrl).toHaveBeenCalledWith("c1", "p1");
  });

  it("prefers the backend's card thumbnail and keeps the original for the lightbox", async () => {
    getMediaUrl.mockResolvedValue({
      downloadUrl: "https://media/p1",
      thumbnailUrl: "https://media/p1.thumb.webp",
    });
    // A fresh checkId: media URLs are memoised per check + artifact.
    const [task] = await hydrateTaskEvidenceFromCheck(
      [{ taskId: "t4", checkId: "c3", sourceArtifactIds: ["p1"] }],
      detail,
    );
    expect(getMediaUrl).toHaveBeenCalledWith("c3", "p1");
    expect(task.thumbnailUrl).toBe("https://media/p1.thumb.webp");
    expect(task.mediaUrl).toBe("https://media/p1");
  });

  it("leaves a task without a matching artifact untouched", async () => {
    const original = { taskId: "t2", checkId: "c1", sourceArtifactIds: ["zz"] };
    const [task] = await hydrateTaskEvidenceFromCheck([original], detail);
    expect(task).toBe(original);
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it("keeps the evidence when the media URL cannot be signed", async () => {
    getMediaUrl.mockRejectedValue(new Error("nope"));
    const [task] = await hydrateTaskEvidenceFromCheck(
      [{ taskId: "t3", checkId: "c2", sourceArtifactIds: ["p1"] }],
      detail,
    );
    expect(task.evidence.georeferencedAddress).toBe("15th St");
    expect(task.mediaUrl).toBeUndefined();
  });
});

beforeEach(() => {
  getMediaUrl.mockReset();
  getMediaUrl.mockResolvedValue({
    downloadUrl: "https://media/default",
    expiresIn: 300,
  });
});
afterEach(() => vi.useRealTimers());
it("renews expired URLs and deduplicates concurrent renewals", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
  getMediaUrl
    .mockResolvedValueOnce({ downloadUrl: "first", expiresIn: 300 })
    .mockResolvedValueOnce({ downloadUrl: "second", expiresIn: 300 });
  const first = await cachedMediaUrls("expiry", "photo");
  vi.advanceTimersByTime(269000);
  expect((await cachedMediaUrls("expiry", "photo")).downloadUrl).toBe("first");
  vi.advanceTimersByTime(2000);
  const results = await Promise.all([
    cachedMediaUrls("expiry", "photo"),
    cachedMediaUrls("expiry", "photo"),
  ]);
  expect(results.map((x) => x.downloadUrl)).toEqual(["second", "second"]);
  expect(first.expiresAt).toBeLessThan(Date.now());
  expect(getMediaUrl).toHaveBeenCalledTimes(2);
});
it("backs off failed hydration and permits retry even with attached evidence", async () => {
  vi.useFakeTimers();
  getMediaUrl
    .mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { status: 429 }),
    )
    .mockResolvedValueOnce({ downloadUrl: "recovered", expiresIn: 300 });
  const [failed] = await hydrateTaskEvidenceFromCheck(
    [{ taskId: "retry", checkId: "retry", sourceArtifactIds: ["p1"] }],
    detail,
  );
  expect(failed.evidence.artifactId).toBe("p1");
  expect(needsTaskEvidenceHydration(failed)).toBe(false);
  await expect(cachedMediaUrls("retry", "p1")).rejects.toThrow("throttled");
  expect(getMediaUrl).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5001);
  expect(needsTaskEvidenceHydration(failed)).toBe(true);
  const [recovered] = await hydrateTaskEvidenceFromCheck([failed], detail);
  expect(recovered.mediaUrl).toBe("recovered");
  expect(needsTaskEvidenceHydration(recovered)).toBe(false);
  expect(getMediaUrl).toHaveBeenCalledTimes(2);
});
it("does not retry text evidence as a missing photo", async () => {
  const [task] = await hydrateTaskEvidenceFromCheck(
    [{ taskId: "text", checkId: "text", sourceArtifactIds: ["d1"] }],
    detail,
  );
  expect(needsTaskEvidenceHydration(task)).toBe(false);
});
it("invalidates one artifact and negative-caches unavailable images temporarily", async () => {
  vi.useFakeTimers();
  await cachedMediaUrls("negative", "photo");
  invalidateMediaUrls("negative", "photo");
  await cachedMediaUrls("negative", "photo");
  expect(getMediaUrl).toHaveBeenCalledTimes(2);
  markMediaUnavailable("negative", "photo");
  invalidateMediaUrls("negative", "photo");
  await expect(cachedMediaUrls("negative", "photo")).rejects.toMatchObject({
    status: 404,
  });
  expect(getMediaUrl).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(60001);
  await cachedMediaUrls("negative", "photo");
  expect(getMediaUrl).toHaveBeenCalledTimes(3);
});
it("does not let an obsolete signing failure shorten a newer unavailable backoff", async () => {
  vi.useFakeTimers();
  /** @type {(error:Error)=>void} */
  let rejectSigning = () => {
    throw new Error("Signing did not start");
  };
  getMediaUrl.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectSigning = reject;
    }),
  );
  const pending = cachedMediaUrls("race", "photo");
  const failed = expect(pending).rejects.toThrow("network");
  markMediaUnavailable("race", "photo");
  rejectSigning(new Error("network"));
  await failed;
  vi.advanceTimersByTime(6000);
  await expect(cachedMediaUrls("race", "photo")).rejects.toMatchObject({
    status: 404,
  });
  expect(getMediaUrl).toHaveBeenCalledTimes(1);
});
