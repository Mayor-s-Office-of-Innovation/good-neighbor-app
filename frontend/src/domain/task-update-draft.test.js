import { describe, expect, it } from "vitest";
import {
  emptyTaskUpdateNotes,
  hasUnsavedTaskUpdateDraft,
} from "./task-update-draft.js";

describe("task update drafts", () => {
  it("creates independent empty note slots", () => {
    const notes = emptyTaskUpdateNotes();
    expect(notes).toEqual(["", "", ""]);
  });

  it("only treats editable flow content as an unsaved draft", () => {
    expect(
      hasUnsavedTaskUpdateDraft("notes", {
        files: [],
        notes: ["A note", "", ""],
        actionText: "",
      }),
    ).toBe(true);
    expect(
      hasUnsavedTaskUpdateDraft("action", {
        files: [],
        notes: ["", "", ""],
        actionText: "Called the agency",
      }),
    ).toBe(true);
    expect(
      hasUnsavedTaskUpdateDraft("timeline", {
        files: ["ignored"],
        notes: ["ignored"],
        actionText: "ignored",
      }),
    ).toBe(false);
  });
});
