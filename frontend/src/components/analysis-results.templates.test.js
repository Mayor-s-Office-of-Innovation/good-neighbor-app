import { describe, expect, it } from "vitest";

import {
  analysisCards,
  problemSummary,
  problemSummaryLabel,
  taskAnalysisCard,
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

describe("taskAnalysisCard", () => {
  it("keeps action guidance visible while preserving the condition description for edits", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task_1",
        checkId: "check_1",
        conditionId: "condition_litter",
        category: "Litter",
        description: "Trash is piled around the tree well.",
        guidance:
          "If there is too much trash for you to clean up, ask the City for help.",
        buttons: ["File 311 ticket"],
      },
      action: { label: "File 311 ticket", variant: "blue", kind: "file311" },
      statusLabel: "TODAY · 10:00AM",
      isNew: false,
    });

    expect(card).toContain(
      "If there is too much trash for you to clean up, ask the City for help.",
    );
    expect(card).toContain(
      'data-card-edit-description="Trash is piled around the tree well."',
    );
  });

  it("omits action, edit, and delete controls for read-only task cards", () => {
    const card = taskAnalysisCard({
      task: {
        taskId: "task_1",
        checkId: "check_1",
        conditionId: "condition_litter",
        category: "Litter",
        description: "Trash is piled around the tree well.",
        guidance: "Clean it up.",
        buttons: ["Cleaned it up"],
      },
      action: { label: "Cleaned it up", variant: "ink", kind: "done" },
      statusLabel: "YESTERDAY · 10:00AM",
      isNew: false,
      includeControls: false,
    });

    expect(card).not.toContain("Cleaned it up</button>");
    expect(card).not.toContain('data-analysis-action="edit"');
    expect(card).not.toContain('data-analysis-action="delete"');
  });
});
