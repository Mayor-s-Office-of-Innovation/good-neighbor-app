import { expect, it } from "vitest";
import { duplicateCard, duplicateDetail } from "./duplicate-issue.templates.js";

it("uses the hydrated photo identity in both duplicate views", () => {
  const task = {
    taskId: "task",
    checkId: "check",
    sourceArtifactIds: ["wrong", "selected"],
    evidence: { artifactId: "selected" },
    mediaUrl: "selected.jpg",
    createdAt: "2026-10-27T12:00:00Z",
    duplicate: {
      original: { taskId: "original", createdAt: "2026-10-26T12:00:00Z" },
    },
  };
  for (const markup of [
    duplicateCard(task),
    duplicateDetail(task, task.mediaUrl, false, ""),
  ]) {
    expect(markup).toContain('data-artifact-id="selected"');
    expect(markup).not.toContain('data-artifact-id="wrong"');
  }
});
