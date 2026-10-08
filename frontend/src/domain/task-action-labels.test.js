import { expect, it } from "vitest";
import { taskActionLabel } from "./task-action-labels.js";
import { ACTIONS_ESCALATIONS_V5_ROWS } from "../../../backend/src/analysis/guidance/actions-escalations-v5.rows.js";
import { ACTIONS_ESCALATIONS_V6_ROWS } from "../../../backend/src/analysis/guidance/actions-escalations-v6.rows.js";
it("uses the v6 snapshot for every new rule, including reused fire IDs", () => {
  for (const row of ACTIONS_ESCALATIONS_V6_ROWS) {
    expect(
      taskActionLabel({
        policyVersion: "actions-escalations-v6",
        ruleId: row[2],
        buttons: [row[12]],
      }),
    ).toBe(row[12]);
  }
  expect(
    taskActionLabel({
      policyVersion: "actions-escalations-v5",
      ruleId: "FIRE-2",
      buttons: ["Call 911"],
    }),
  ).toBe("Call 911");
  expect(
    taskActionLabel({
      policyVersion: "actions-escalations-v6",
      ruleId: "FIRE-2",
      buttons: ["File 311 ticket"],
    }),
  ).toBe("File 311 ticket");
});
it("keeps existing-task display labels aligned with the legacy rubric", () => {
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
