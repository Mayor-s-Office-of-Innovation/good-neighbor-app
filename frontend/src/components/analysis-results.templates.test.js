import { describe, expect, it } from "vitest";

import {
  analysisCards,
  problemSummary,
  problemSummaryLabel,
} from "./analysis-results.templates.js";

describe("analysis result summaries", () => {
  it("counts the same problem units that the tray renders when tasks and conditions differ", () => {
    const items = [
      {
        id: "item_1",
        kind: "photo",
        placeName: "15th St",
        analysis: {
          status: "analyzed",
          tasks: [
            {
              taskId: "task_1",
              conditionId: "condition_litter",
              category: "Litter",
              guidance: "File a 311 ticket.",
              kind: "escalation",
              buttons: ["File 311 ticket"],
            },
          ],
          conditions: [
            {
              conditionId: "condition_litter",
              category: "Litter",
              description: "Trash is visible.",
            },
            {
              conditionId: "condition_extra",
              category: "Needles",
              description: "A second analyzer condition is present.",
            },
          ],
        },
      },
    ];

    expect(analysisCards(items[0], "check_1")).toHaveLength(1);
    expect(problemSummary(items)).toEqual({ visible: 1, hidden: 0 });
    expect(problemSummaryLabel(problemSummary(items))).toBe("1 problem found");
  });
});
