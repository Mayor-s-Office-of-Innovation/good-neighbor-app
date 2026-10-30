import { setDuplicateUiSite } from "../services/feature-flags.js";
import { beforeEach, expect, it } from "vitest";
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
    duplicateSeenCount: 1,
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

beforeEach(() =>
  setDuplicateUiSite({ featureFlags: { duplicateDetection: true } }),
);

it("restores ordinary cards from persisted duplicate UI state when display is off", () => {
  setDuplicateUiSite(null);
  const result = projectDuplicateTasks(
    [
      {
        ...repeat,
        duplicateHidden: true,
        duplicate: { compact: true },
        duplicateCheckState: "pending",
      },
    ],
    new Map([["repeat", { state: "matched", original }]]),
  );
  expect(result).toHaveLength(1);
  expect(result[0].duplicate).toBeUndefined();
  expect(result[0].duplicateHidden).toBe(false);
  expect(result[0].duplicateCheckState).toBeUndefined();
});

it("uses the original issue's phone action metadata for a duplicate", () => {
  const root = {
    ...original,
    kind: "non_actionable_escalation",
    phoneNumber: "415-553-0123",
    buttons: ["Call SFPD: 415-553-0123"],
  };
  const child = { ...repeat, kind: "action", phoneNumber: "311" };
  const [projected] = projectDuplicateTasks(
    [child],
    new Map([[child.taskId, { state: "matched", original: root }]]),
    now,
  );
  expect(projected.phoneNumber).toBe(root.phoneNumber);
  expect(projected.kind).toBe(root.kind);
  expect(projected.buttons).toEqual(root.buttons);
  const [legacy] = projectDuplicateTasks(
    [child],
    new Map([
      [
        child.taskId,
        { state: "matched", original: { ...root, phoneNumber: undefined } },
      ],
    ]),
    now,
  );
  expect(legacy.phoneNumber).toBeUndefined();
});

it("counts the original and distinct matched observations, and removes separated sightings", () => {
  const relations = new Map([
    ["repeat", { state: "matched", original }],
    ["other", { state: "matched", original }],
    ["separated", { state: "separated", original }],
  ]);
  const projected = projectDuplicateTasks([original, repeat], relations, now);
  expect(
    projected.find((t) => t.taskId === original.taskId).duplicateSeenCount,
  ).toBe(3);
  relations.set("other", { state: "separated", original });
  expect(
    projectDuplicateTasks([original, repeat], relations, now)[0]
      .duplicateSeenCount,
  ).toBe(2);
});

it("collapses every related card after explicit filing, including later observations", () => {
  const filed = {
    ...original,
    status: "in_progress",
    inProgressActionKind: "311_filed",
    inProgressAt: "2026-10-15T10:00:00Z",
    updatedAt: "2026-10-15T10:00:10Z",
    appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
  };
  const later = { ...repeat, taskId: "later" };
  const relations = new Map([
    ["repeat", { state: "matched", original: filed }],
    ["later", { state: "matched", original: filed }],
  ]);
  for (const input of [
    [filed, repeat, later],
    [repeat, later],
  ]) {
    const tasks = projectDuplicateTasks(input, relations, now);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      taskId: "original",
      status: "in_progress",
      duplicateSeenCount: 3,
      appActionResults: filed.appActionResults,
    });
  }
});

it("does not let a stale duplicate cache overwrite a confirmed filing", () => {
  const filed = {
    ...original,
    status: "in_progress",
    inProgressActionKind: "311_filed",
    updatedAt: "2026-10-15T11:30:00Z",
    appActionResults: [{ code: "create_311_ticket", status: "submitted" }],
  };
  const stale = { ...original, updatedAt: "2026-10-15T09:00:00Z" };
  const tasks = projectDuplicateTasks([filed, repeat], links(stale), now);
  expect(tasks).toHaveLength(1);
  expect(tasks[0].appActionResults).toEqual(filed.appActionResults);
  expect(tasks[0].status).toBe("in_progress");
});

it.each(["queued", "failed"])(
  "does not treat a %s filing as submitted",
  (status) => {
    const root = {
      ...original,
      status: "in_progress",
      inProgressActionKind: "311_filed",
      inProgressAt: "2026-10-15T10:00:00Z",
      appActionStatus: status,
      appActionResults: [],
    };
    const tasks = projectDuplicateTasks([root, repeat], links(root), now);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].appActionStatus).toBe(status);
  },
);

it.each([false, true])(
  "preserves ticket evidence with equal task timestamps (fresh worklist=%s)",
  (freshWorklist) => {
    const stale = {
      ...original,
      updatedAt: "2026-10-15T10:00:00Z",
      appActionResults: [],
      appActionStatus: "pending",
    };
    const fresh = {
      ...stale,
      appActionStatus: "submitted",
      appActionResults: [
        {
          code: "create_311_ticket",
          status: "submitted",
          recordedAt: "2026-10-15T10:01:00Z",
          payload: { tickets: [{ srNum: "synthetic-ticket" }] },
        },
      ],
    };
    const tasks = projectDuplicateTasks(
      [freshWorklist ? fresh : stale, repeat],
      links(freshWorklist ? stale : fresh),
      now,
    );
    expect(tasks.find((t) => t.taskId === "original")).toMatchObject({
      appActionStatus: "submitted",
      appActionResults: fresh.appActionResults,
    });
  },
);

it("uses integration timestamps when both equal-timestamp snapshots contain results", () => {
  const older = {
    ...original,
    updatedAt: "2026-10-15T10:00:00Z",
    appActionStatus: "failed",
    appActionResults: [
      {
        code: "create_311_ticket",
        status: "failed",
        recordedAt: "2026-10-15T10:01:00Z",
      },
    ],
  };
  const newer = {
    ...older,
    appActionStatus: "submitted",
    appActionResults: [
      {
        code: "create_311_ticket",
        status: "submitted",
        recordedAt: "2026-10-15T10:02:00Z",
      },
    ],
  };
  for (const [worklist, linked] of [
    [older, newer],
    [newer, older],
  ]) {
    const result = projectDuplicateTasks(
      [worklist, repeat],
      links(linked),
      now,
    );
    expect(result[0].appActionResults).toEqual(newer.appActionResults);
    expect(result[0].appActionStatus).toBe("submitted");
  }
});
