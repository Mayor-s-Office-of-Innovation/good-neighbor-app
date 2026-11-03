import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  check: null,
  update: vi.fn(),
  edit: vi.fn(),
  task: vi.fn(),
}));
vi.mock("./api.js", () => ({
  editAnalysisCondition: state.edit,
  updateTaskAction: state.task,
}));
vi.mock("../state/check-session.js", () => ({
  getCurrentCheck: () => state.check,
  getCheck: () => state.check,
  updateItemAnalysis: state.update,
}));
import { saveCardDescription, syncCardDetails } from "./card-description.js";
beforeEach(() => {
  vi.clearAllMocks();
  state.check = {
    id: "check",
    items: [
      {
        id: "photo",
        analysis: {
          conditions: [
            { conditionId: "one", description: "Original" },
            { conditionId: "two", description: "Unchanged" },
          ],
          tasks: [
            { taskId: "task", conditionId: "one", description: "Original" },
          ],
        },
      },
    ],
  };
});
it("corrects a pending question locally and remotely without publishing new guidance", async () => {
  await saveCardDescription(
    {
      checkId: "check",
      artifactId: "artifact",
      conditionId: "one",
      itemId: "photo",
    },
    "Corrected text",
  );
  expect(state.edit).toHaveBeenCalledWith("check", "artifact", "one", {
    description: "Corrected text",
  });
  expect(state.update.mock.calls[0][1].conditions).toEqual([
    {
      conditionId: "one",
      description: "Corrected text",
      descriptionEdited: true,
    },
    { conditionId: "two", description: "Unchanged" },
  ]);
  expect(state.task).not.toHaveBeenCalled();
});
it("uses the task correction endpoint for a generated task during capture", async () => {
  await saveCardDescription(
    { checkId: "check", conditionId: "one", itemId: "photo", taskId: "task" },
    "Corrected text",
  );
  expect(state.task).toHaveBeenCalledWith("task", undefined, "Corrected text");
  expect(state.edit).not.toHaveBeenCalled();
});
it("saves a recovered question without requiring a retained local check", async () => {
  state.check = null;
  await saveCardDescription(
    { checkId: "check", artifactId: "artifact", conditionId: "one" },
    "Corrected text",
  );
  expect(state.edit).toHaveBeenCalledOnce();
  expect(state.update).not.toHaveBeenCalled();
});
it("leaves the local description unchanged if saving fails", async () => {
  state.edit.mockRejectedValueOnce(new Error("offline"));
  await expect(
    saveCardDescription(
      { checkId: "check", conditionId: "one", itemId: "photo" },
      "Corrected text",
    ),
  ).rejects.toThrow("offline");
  expect(state.update).not.toHaveBeenCalled();
});

it("updates a duplicate with shared action fields without inserting its root", () => {
  syncCardDetails(
    {
      checkId: "check",
      conditionId: "one",
      itemId: "photo",
      taskId: "task",
    },
    {
      task: {
        taskId: "root",
        category: "Graffiti",
        buttons: ["File 311 ticket"],
        guidance: "Report it to the City.",
      },
    },
    { title: "Edited title", description: "Corrected text" },
  );

  expect(state.update.mock.calls[0][1].tasks).toEqual([
    {
      taskId: "task",
      conditionId: "one",
      category: "Graffiti",
      buttons: ["File 311 ticket"],
      guidance: "Report it to the City.",
      userFriendlyLabel: "Edited title",
      titleEdited: true,
      description: "Corrected text",
      descriptionEdited: true,
    },
  ]);
});
