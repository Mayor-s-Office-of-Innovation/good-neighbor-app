import { expect, it } from "vitest";
import { taskActionLabel } from "./task-action-labels.js";
import { ACTIONS_ESCALATIONS_V5_ROWS } from "../../../backend/src/analysis/guidance/actions-escalations-v5.rows.js";
it("keeps existing-task display labels aligned with the active rubric", () => {
  for (const row of ACTIONS_ESCALATIONS_V5_ROWS) {
    expect(taskActionLabel({ ruleId: row[2], buttons: ["old label"] })).toBe(
      row[12],
    );
  }
});
it("preserves labels for unknown historical rules", () => {
  expect(
    taskActionLabel({ ruleId: "older-rule", buttons: ["Historical action"] }),
  ).toBe("Historical action");
});
