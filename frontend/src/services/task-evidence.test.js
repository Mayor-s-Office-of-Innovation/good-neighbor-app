import { beforeEach, describe, expect, it, vi } from "vitest";

const getMediaUrl = vi.fn();
vi.mock("./api.js", () => ({
  getCheck: vi.fn(),
  getMediaUrl: (...args) => getMediaUrl(...args),
}));

const { hydrateTaskEvidenceFromCheck } = await import("./task-evidence.js");

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

  it("attaches the source artifact's street and a signed thumbnail", async () => {
    const [task] = await hydrateTaskEvidenceFromCheck(
      [{ taskId: "t1", checkId: "c1", sourceArtifactIds: ["p1"] }],
      detail,
    );
    expect(task.evidence).toEqual({
      artifactId: "p1",
      placeName: "",
      georeferencedAddress: "15th St",
      text: "",
    });
    expect(task.thumbnailUrl).toBe("https://media/p1");
    expect(getMediaUrl).toHaveBeenCalledWith("c1", "p1");
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
    expect(task.thumbnailUrl).toBeUndefined();
  });
});
