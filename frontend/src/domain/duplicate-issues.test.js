import { expect, it } from "vitest";
import { projectDuplicateTasks, duplicateCounts } from "./duplicate-issues.js";
const now = Date.parse("2026-10-15T12:00:00Z");
const original = {
  taskId: "original",
  status: "open",
  createdAt: "2026-10-15T09:00:00Z",
  buttons: ["Call"],
  kind: "escalation",
};
const repeat = {
  taskId: "repeat",
  status: "open",
  createdAt: "2026-10-15T11:00:00Z",
  description: "New observation",
};
/** @param {Record<string,any>} root */
const links = (root) =>
  new Map([["repeat", { state: "matched", original: root }]]);
it("keeps both open issues actionable, with one shared action definition", () => {
  const tasks = projectDuplicateTasks([original, repeat], links(original), now);
  expect(tasks).toHaveLength(2);
  expect(tasks[1].duplicate.compact).toBe(false);
  expect(tasks[1].buttons).toEqual(original.buttons);
  expect(tasks[1].description).toBe(repeat.description);
  expect(duplicateCounts(tasks)).toEqual({ newCount: 1, duplicateCount: 1 });
});
it("a new repeat of an in-progress issue becomes the small duplicate card", () => {
  const root = {
    ...original,
    status: "in_progress",
    inProgressAt: "2026-10-15T10:00:00Z",
  };
  expect(
    projectDuplicateTasks([root, repeat], links(root), now)[1].duplicate
      .compact,
  ).toBe(true);
});
it("acting on the group removes all earlier duplicate cards and keeps one original", () => {
  const root = {
    ...original,
    status: "in_progress",
    inProgressAt: "2026-10-15T11:30:00Z",
  };
  expect(
    projectDuplicateTasks([root, repeat], links(root), now).map(
      (t) => t.taskId,
    ),
  ).toEqual(["original"]);
  expect(
    projectDuplicateTasks(
      [root, repeat],
      links({ ...root, status: "completed" }),
      now,
    ).map((t) => t.taskId),
  ).toEqual(["original"]);
});
it("separation restores the full independent task after the group was acted on", () => {
  const root = {
    ...original,
    status: "in_progress",
    inProgressAt: "2026-10-15T11:30:00Z",
  };
  const tasks = projectDuplicateTasks(
    [root, repeat],
    new Map([["repeat", { state: "separated" }]]),
    now,
  );
  expect(tasks).toHaveLength(2);
  expect(tasks[1]).toEqual({
    ...repeat,
    duplicate: undefined,
    duplicateCheckState: "separated",
  });
});
it("includes the original even if its worklist card was outside the requested page", () => {
  expect(
    projectDuplicateTasks([repeat], links(original), now).map((t) => t.taskId),
  ).toEqual(["repeat", "original"]);
});

it("never injects originals from a prior site's or prior screen's link cache", () => {
  expect(projectDuplicateTasks([], links(original), now)).toEqual([]);
  expect(
    projectDuplicateTasks(
      [{ taskId: "other-site-task", status: "open" }],
      links(original),
      now,
    ).map((task) => task.taskId),
  ).toEqual(["other-site-task"]);
});
