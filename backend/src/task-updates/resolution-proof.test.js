import { beforeEach, expect, it, vi } from "vitest";
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./task-update-store.js", () => ({ readUpdateById: read }));
import { withResolutionProof } from "./resolution-proof.js";
const task = {
  taskId: "task",
  status: "completed",
  completionMethod: "site_team_resolved",
  latestUpdateId: "done",
};
beforeEach(() => read.mockReset());
it.each([
  "issue_resolved",
  "presence_resolved",
  "additional_action_resolved",
  "task_completed",
])("recognizes legacy %s documentation", async (type) => {
  read.mockResolvedValue({
    type,
    notes: ["Cleaned"],
    occurredAt: "2026-10-28",
  });
  expect((await withResolutionProof("table", "site", task)).proofAddedAt).toBe(
    "2026-10-28",
  );
});
it.each(["note_photo_update", "additional_action"])(
  "ignores earlier %s evidence",
  async (type) => {
    read.mockResolvedValue({
      type,
      notes: ["Before completion"],
      photoKeys: ["photo"],
      occurredAt: "2026-10-27",
    });
    expect(
      (await withResolutionProof("table", "site", task)).proofAddedAt,
    ).toBeNull();
  },
);
it("allows proof after an older completion was skipped, and with no timeline event", async () => {
  read.mockResolvedValue({
    type: "issue_resolved",
    documentationState: "closed",
    notes: [],
    photoKeys: [],
  });
  expect(
    (await withResolutionProof("table", "site", task)).proofAddedAt,
  ).toBeNull();
  read.mockClear();
  expect(
    (
      await withResolutionProof("table", "site", {
        ...task,
        latestUpdateId: undefined,
      })
    ).proofAddedAt,
  ).toBeNull();
  expect(read).not.toHaveBeenCalled();
});
it("does not read timelines for expired-only or documented cards", async () => {
  for (const item of [
    { ...task, status: "open" },
    { ...task, proofAddedAt: "2026-10-28" },
  ])
    expect(await withResolutionProof("table", "site", item)).toBe(item);
  expect(read).not.toHaveBeenCalled();
});
