import { describe, expect, it } from "vitest";
import { taskMediaUrl, taskMediaArtifactId } from "./task-media.js";

describe("task media", () => {
  it("uses the same hydrated media precedence for every task component", () => {
    expect(taskMediaUrl({ thumbnailUrl: "thumb", mediaUrl: "media" })).toBe(
      "thumb",
    );
    expect(taskMediaUrl({ photoUrl: "photo" })).toBe("photo");
    expect(taskMediaUrl({})).toBe("");
  });
});

it("pairs hydrated media with its selected artifact before source order", () => {
  expect(
    taskMediaArtifactId({
      sourceArtifactIds: ["first", "selected"],
      evidence: { artifactId: "selected" },
    }),
  ).toBe("selected");
  expect(taskMediaArtifactId({ sourceArtifactIds: ["first"] })).toBe("first");
  expect(taskMediaArtifactId({})).toBe("");
});

it("retains legacy assessment artifact identity when explicit sources are absent", () => {
  const id = "22222222-2222-2222-2222-222222222222";
  expect(
    taskMediaArtifactId({
      assessmentId: `11111111-1111-1111-1111-111111111111-${id}`,
    }),
  ).toBe(id);
});
