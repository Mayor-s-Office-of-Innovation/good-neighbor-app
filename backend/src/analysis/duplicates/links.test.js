import { beforeEach, expect, it, vi } from "vitest";
import { analysisRevision, projectionKey } from "./jobs.js";
const state = vi.hoisted(() => ({
  items: new Map(),
  writes: /** @type {any[]} */ ([]),
}));
vi.mock("../../db.js", () => ({
  ddb: {
    send: async (/** @type {any} */ command) => {
      const i = command.input;
      if (i.Key) return { Item: state.items.get(i.Key.pk + "|" + i.Key.sk) };
      state.writes.push(i);
      for (const entry of i.TransactItems ?? [])
        if (entry.Put)
          state.items.set(
            entry.Put.Item.pk + "|" + entry.Put.Item.sk,
            entry.Put.Item,
          );
      return {};
    },
  },
}));
import {
  duplicateForTask,
  reconcileObservation,
  sharedActionTarget,
  overrideKey,
} from "./links.js";
import { separateDuplicate } from "../../handlers/duplicate-links.js";
vi.mock("../../config.js", () => ({
  getConfig: () => ({ dynamoTable: "test" }),
}));
vi.mock("../../lib/principal.js", () => ({
  deriveSiteId: () => "site",
  deriveActorId: () => "actor",
}));
/** @param {Record<string,any>} item */
const put = (item) => state.items.set(item.pk + "|" + item.sk, item);
/** @param {string} id @param {string} time @param {string} [status] */
function issue(id, time, status = "open") {
  const pk = "SITE#site",
    analysis = {
      pk,
      sk: `CHECK#${id}#ANALYSIS#photo`,
      analysisId: id,
      status: "analyzed",
      analyzedAt: time,
      concerns: [
        {
          conditionId: "condition",
          category: "Litter",
          rating: 2,
          explanation: "Blue sofa by north gate",
        },
      ],
    };
  const revision = analysisRevision(analysis),
    ref = { observationId: `${id}:photo`, conditionId: "condition", revision };
  const task = {
    pk,
    sk: `TASK#${id}`,
    entityType: "TASK",
    taskId: id,
    checkId: id,
    assessmentId: id,
    conditionId: "condition",
    sourceArtifactIds: ["photo"],
    status,
    createdAt: time,
    updatedAt: time,
    shortId: id,
  };
  put(analysis);
  put(task);
  put({ pk, sk: `CHECK#${id}#ART#photo`, capturedAt: "2026-01-01T00:00:00Z" });
  put({ ...projectionKey("site", time, ref.observationId), revision });
  put({
    pk,
    sk: `GUIDANCE_CURRENT#${JSON.stringify([id, "photo"])}`,
    assessmentId: id,
  });
  put({ pk, sk: `ASSESSMENT#${id}#COND#condition`, taskIds: [id] });
  put({
    pk,
    sk: `DUP_RESULT#${ref.observationId}#${revision}`,
    status: "evaluated",
    processingState: "complete",
    conditionResults: [
      {
        conditionId: "condition",
        possibleDuplicate: false,
        status: "evaluated",
      },
    ],
  });
  return { task, analysis, ref };
}
function fixture() {
  const old = issue("old", "2026-10-14T09:00:00Z"),
    recent = issue("recent", "2026-10-15T10:00:00Z");
  put({
    pk: "SITE#site",
    sk: `DUP_ISSUE#recent:photo#${recent.ref.revision}#condition`,
    possibleDuplicate: true,
    matchStrength: "strong",
    duplicateOf: old.ref,
    updatedAt: "2026-10-15T10:01:00Z",
  });
  return { old, recent };
}
beforeEach(() => {
  state.items.clear();
  state.writes.length = 0;
  process.env.DUPLICATE_DETECTION_ENABLED = "true";
});
it("resolves current issue/task identities using generation times, not capture times", async () => {
  const { old, recent } = fixture();
  const relation = await duplicateForTask("test", "site", recent.task);
  expect(relation.state).toBe("matched");
  expect(relation.original.taskId).toBe(old.task.taskId);
  expect((await sharedActionTarget("test", "site", "recent")).taskId).toBe(
    "old",
  );
});
it("records the repeat exactly once on the original timeline", async () => {
  fixture();
  await reconcileObservation("test", "site", "recent", "photo");
  await reconcileObservation("test", "site", "recent", "photo");
  const events = [...state.items.values()].filter(
    (i) => i.type === "duplicate_detected",
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    taskId: "old",
    sourceTaskId: "recent",
    sourceArtifactId: "photo",
  });
});
it("a durable separation restores independent actions without undoing the original's action", async () => {
  const { old, recent } = fixture();
  old.task.status = "in_progress";
  put(old.task);
  const response = await separateDuplicate({
    pathParameters: { taskId: "recent" },
    body: JSON.stringify({
      sourceRevision: recent.ref.revision,
      originalTaskId: "old",
    }),
  });
  expect(response.statusCode).toBe(200);
  expect((await duplicateForTask("test", "site", recent.task)).state).toBe(
    "separated",
  );
  expect((await sharedActionTarget("test", "site", "recent")).taskId).toBe(
    "recent",
  );
  await reconcileObservation("test", "site", "recent", "photo");
  expect(
    [...state.items.values()].filter((i) => i.type === "duplicate_detected"),
  ).toHaveLength(0);
  expect(state.items.get("SITE#site|TASK#old").status).toBe("in_progress");
  expect(
    (
      await separateDuplicate({
        pathParameters: { taskId: "recent" },
        body: JSON.stringify({
          sourceRevision: recent.ref.revision,
          originalTaskId: "old",
        }),
      })
    ).statusCode,
  ).toBe(200);
});
it("cannot separate while a shared action is being saved", async () => {
  const { old, recent } = fixture();
  put({ ...old.task, status: "completing" });
  expect(
    (
      await separateDuplicate({
        pathParameters: { taskId: "recent" },
        body: JSON.stringify({
          sourceRevision: recent.ref.revision,
          originalTaskId: "old",
        }),
      })
    ).statusCode,
  ).toBe(409);
  expect(
    state.items.has("SITE#site|" + overrideKey("site", recent.task).sk),
  ).toBe(false);
});
it("physically resolved originals cannot collapse or receive another report", async () => {
  const { old, recent } = fixture();
  put({ ...old.task, resolvedAt: "2026-10-14T00:00:00Z" });
  expect((await duplicateForTask("test", "site", recent.task)).state).toBe(
    "complete",
  );
  expect((await sharedActionTarget("test", "site", "recent")).taskId).toBe(
    "recent",
  );
});
it("stale analyses, removed evidence and another site's IDs cannot create links", async () => {
  const { recent } = fixture();
  state.items.delete("SITE#site|CHECK#recent#ART#photo");
  expect((await duplicateForTask("test", "site", recent.task)).state).toBe(
    "pending",
  );
  expect((await duplicateForTask("test", "other", recent.task)).state).toBe(
    "pending",
  );
});
it("human separation stops a duplicate chain at the separated observation", async () => {
  const { old, recent } = fixture(),
    newest = issue("newest", "2026-10-15T11:00:00Z");
  put({ ...overrideKey("site", recent.task), taskId: "recent" });
  put({
    pk: "SITE#site",
    sk: `DUP_ISSUE#newest:photo#${newest.ref.revision}#condition`,
    possibleDuplicate: true,
    matchStrength: "strong",
    duplicateOf: recent.ref,
  });
  expect(
    (await duplicateForTask("test", "site", newest.task)).original.taskId,
  ).toBe("recent");
  expect(old.task.taskId).toBe("old");
});

it("adopts an action that finished before the match, without executing it again", async () => {
  const { recent } = fixture();
  put({
    ...recent.task,
    status: "in_progress",
    kind: "escalation",
    inProgressAt: "2026-10-15T10:02:00Z",
    appActionResults: [{ code: "create_311_ticket", status: "succeeded" }],
  });
  await reconcileObservation("test", "site", "recent", "photo");
  expect(state.items.get("SITE#site|TASK#old").status).toBe("in_progress");
  expect(state.items.get("SITE#site|TASK#old").appActionResults).toHaveLength(
    1,
  );
  const result = await separateDuplicate({
    pathParameters: { taskId: "recent" },
    body: JSON.stringify({
      sourceRevision: recent.ref.revision,
      originalTaskId: "old",
    }),
  });
  expect(result.statusCode).toBe(200);
  const restoredId = JSON.parse(result.body).taskId;
  expect(restoredId).not.toBe("recent");
  expect(state.items.get(`SITE#site|TASK#${restoredId}`)).toMatchObject({
    status: "open",
    restoredFromTaskId: "recent",
    appActionResults: [],
  });
  expect(state.items.get("SITE#site|TASK#old").status).toBe("in_progress");
  expect(
    state.items.get("SITE#site|ASSESSMENT#recent#COND#condition").taskIds,
  ).toEqual([restoredId]);
});
it("rejects a separation made against a different issue revision", async () => {
  fixture();
  expect(
    (
      await separateDuplicate({
        pathParameters: { taskId: "recent" },
        body: JSON.stringify({
          sourceRevision: "obsolete",
          originalTaskId: "old",
        }),
      })
    ).statusCode,
  ).toBe(409);
});

it("disabling new detection preserves shared actions for already materialized links", async () => {
  fixture();
  await reconcileObservation("test", "site", "recent", "photo");
  process.env.DUPLICATE_DETECTION_ENABLED = "false";
  expect((await sharedActionTarget("test", "site", "recent")).taskId).toBe(
    "old",
  );
});

it("batch polling remains site-scoped and preserves existing groups when detection is disabled", async () => {
  const { getDuplicateLinks } = await import(
    "../../handlers/duplicate-links.js"
  );
  fixture();
  await reconcileObservation("test", "site", "recent", "photo");
  process.env.DUPLICATE_DETECTION_ENABLED = "false";
  const result = await getDuplicateLinks({
    body: JSON.stringify({ taskIds: ["recent", "foreign"] }),
  });
  expect(result.statusCode).toBe(200);
  const body = JSON.parse(result.body);
  expect(body.enabled).toBe(true);
  expect(body.issues[0]).toMatchObject({
    taskId: "recent",
    state: "matched",
    original: { taskId: "old" },
  });
  expect(body.issues[1]).toMatchObject({
    taskId: "foreign",
    state: "disabled",
  });
  expect(
    (
      await getDuplicateLinks({
        body: JSON.stringify({ taskIds: Array(51).fill("recent") }),
      })
    ).statusCode,
  ).toBe(400);
});

it("never publishes a direct match outside the generation-time window", async () => {
  const { old, recent } = fixture();
  put({ ...old.analysis, analyzedAt: "2026-10-12T10:00:00Z" });
  expect((await duplicateForTask("test", "site", recent.task)).state).toBe(
    "complete",
  );
});

it.each(["no_match_with_failures", "incomplete"])(
  "does not describe %s assessments as a clean no-match",
  async (assessmentOutcome) => {
    const { task, ref } = issue("incomplete", "2026-10-15T10:00:00Z");
    const result = state.items.get(
      `SITE#site|DUP_RESULT#incomplete:photo#${ref.revision}`,
    );
    result.conditionResults[0].assessmentOutcome = assessmentOutcome;
    expect((await duplicateForTask("test", "site", task)).state).toBe(
      "unavailable",
    );
  },
);

it("uses fresh revision timing before projection exists, not the old task's age", async () => {
  const { task, ref } = issue("requeued", "2026-10-15T10:00:00Z");
  const queuedAt = new Date().toISOString();
  put({
    pk: task.pk,
    sk: `DUP_RESULT#requeued:photo#${ref.revision}`,
    status: "pending",
    queuedAt,
  });
  state.items.delete(
    task.pk + "|" + projectionKey("site", task.createdAt, "requeued:photo").sk,
  );
  const { getDuplicateLinks } = await import(
    "../../handlers/duplicate-links.js"
  );
  vi.stubEnv("DUPLICATE_DETECTION_ENABLED", "true");
  try {
    const response = await getDuplicateLinks({
      body: JSON.stringify({ taskIds: [task.taskId] }),
    });
    expect(JSON.parse(response.body).issues[0].state).toBe("pending");
    const relation = await duplicateForTask("test", "site", task);
    expect(relation.pendingSince).toBe(queuedAt);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("uses fixed analysis readiness without a result and honors explicit recovery timing", async () => {
  const { task, ref } = issue("timing", "2026-10-15T10:00:00Z");
  const sk = `DUP_RESULT#timing:photo#${ref.revision}`;
  state.items.delete(task.pk + "|" + sk);
  const { visibleDuplicateState } = await import("./result-state.js");
  const first = await duplicateForTask("test", "site", task);
  expect(first.pendingSince).toBe(task.createdAt);
  expect(
    visibleDuplicateState(
      first.state,
      first.pendingSince,
      Date.parse(task.createdAt) + 900000,
    ),
  ).toBe("unavailable");
  expect((await duplicateForTask("test", "site", task)).pendingSince).toBe(
    first.pendingSince,
  );
  const now = new Date().toISOString();
  put({
    pk: task.pk,
    sk,
    status: "evaluated",
    evaluatedAt: task.createdAt,
    recoveryRequestedAt: now,
    conditionResults: [
      {
        conditionId: "condition",
        possibleDuplicate: false,
        assessmentOutcome: "no_match_with_failures",
      },
    ],
  });
  const recovery = await duplicateForTask("test", "site", task);
  expect(recovery.state).toBe("pending");
  expect(recovery.pendingSince).toBe(now);
  expect(
    visibleDuplicateState(
      recovery.state,
      recovery.pendingSince,
      Date.parse(now) + 900000,
    ),
  ).toBe("unavailable");
});

it("keeps an assessed condition complete when another condition makes the source incomplete", async () => {
  const { task, ref } = issue("mixed", "2026-10-15T10:00:00Z");
  const result = state.items.get(
    `SITE#site|DUP_RESULT#mixed:photo#${ref.revision}`,
  );
  result.status = "incomplete";
  result.processingState = "incomplete";
  result.conditionResults.push({
    conditionId: "another",
    status: "insufficient_evidence",
    possibleDuplicate: null,
    assessmentOutcome: "incomplete",
    failedCandidateCount: 3,
  });
  expect((await duplicateForTask("test", "site", task)).state).toBe("complete");
});
