import { describe, expect, it, vi } from "vitest";
import {
  stageDeletion,
  pendingDeletedConditionIds,
  isTaskPendingDeletion,
} from "./pending-deletions.js";
import {
  analysisCards,
  problemSummary,
} from "../components/analysis-results.templates.js";

const problem = {
  checkId: "check",
  artifactId: "artifact",
  conditionId: "condition",
  taskId: "task",
};

describe("pending deletion overlay", () => {
  it("filters home tasks and capture cards/counts without mutating the persisted session", () => {
    const item = {
      analysis: {
        status: "analyzed",
        checkId: "check",
        artifactId: "artifact",
        conditions: [{ conditionId: "condition", category: "Litter" }],
        tasks: [{ taskId: "task", conditionId: "condition" }],
      },
    };
    const original = JSON.stringify(item);
    const pending = stageDeletion(problem, vi.fn());
    expect(analysisCards(item, "check")).toEqual([]);
    expect(problemSummary([item])).toEqual({ visible: 0, hidden: 1 });
    expect(isTaskPendingDeletion({ taskId: "task" })).toBe(true);
    expect(
      isTaskPendingDeletion({
        checkId: "check",
        conditionId: "condition",
        sourceArtifactIds: ["artifact"],
      }),
    ).toBe(true);
    expect(
      pendingDeletedConditionIds({
        checkId: "other-check",
        artifactId: "artifact",
      }),
    ).toEqual([]);
    expect(JSON.stringify(item)).toBe(original);
    pending.undo();
    expect(analysisCards(item, "check")).toHaveLength(1);
    expect(problemSummary([item])).toEqual({ visible: 1, hidden: 0 });
    expect(isTaskPendingDeletion({ taskId: "task" })).toBe(false);
  });

  it("serializes saves for the same evidence without blocking other evidence", async () => {
    let finishFirst = () => {};
    const firstCommit = vi.fn(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve(undefined);
        }),
    );
    const secondCommit = vi.fn();
    const otherCommit = vi.fn();
    const first = stageDeletion(
      { ...problem, artifactId: "shared", conditionId: "first" },
      firstCommit,
    );
    const second = stageDeletion(
      { ...problem, artifactId: "shared", conditionId: "second" },
      secondCommit,
    );
    const other = stageDeletion(
      { ...problem, artifactId: "other" },
      otherCommit,
    );
    const firstSave = first.save();
    const secondSave = second.save();
    await other.save();
    expect(firstCommit).toHaveBeenCalledOnce();
    expect(secondCommit).not.toHaveBeenCalled();
    expect(otherCommit).toHaveBeenCalledOnce();
    finishFirst();
    await Promise.all([firstSave, secondSave]);
    expect(secondCommit).toHaveBeenCalledOnce();
  });

  it("prevents duplicate deletion and Undo after a save begins", async () => {
    const commit = vi.fn();
    const pending = stageDeletion(problem, commit);
    expect(stageDeletion(problem, commit)).toBeNull();
    const saved = pending.save();
    pending.undo();
    await saved;
    await pending.save();
    expect(commit).toHaveBeenCalledOnce();
    expect(isTaskPendingDeletion({ taskId: "task" })).toBe(true);
  });
});
