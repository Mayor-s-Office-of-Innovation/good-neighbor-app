import { describe, it, expect, vi, beforeEach } from "vitest";
import { statusRecords, health, projectStatus } from "./system-status.js";
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../db.js", () => ({ ddb: { send } }));
vi.mock("../config.js", () => ({ getDynamoTableName: () => "table" }));
beforeEach(() => send.mockReset());
const base = { pk: "SITE#one" };
describe("system status reporting", () => {
  it("uses unrounded thresholds and a neutral empty state", () => {
    expect(health(0, 0, 90, 75).state).toBe("gray");
    expect(health(749, 1000, 75, 25).state).toBe("orange");
    expect(health(75, 100, 75, 25).state).toBe("green");
    expect(health(249, 1000, 75, 25).state).toBe("red");
    expect(health(899, 1000, 90, 75).state).toBe("orange");
    expect(health(75, 100, 90, 75).state).toBe("orange");
  });
  it("counts text evidence at server receipt, never capture time or complaint/update photos", () => {
    const artifact = {
      ...base,
      sk: "CHECK#c#ART#a",
      checkId: "c",
      artifactId: "a",
      receivedAt: "2026-10-24T18:00:00Z",
      capturedAt: "2020-01-01T00:00:00Z",
      text: "Litter",
    };
    expect(statusRecords(artifact)[0]).toMatchObject({
      kind: "submissions",
      at: artifact.receivedAt,
      artifactId: "a",
    });
    expect(statusRecords({ ...artifact, receivedAt: undefined })).toEqual([]);
    expect(statusRecords({ ...artifact, sk: "COMPLAINT#c#ART#a" })).toEqual([]);
    expect(statusRecords({ ...artifact, sk: "TASK#t#MEDIA#a" })).toEqual([]);
  });
  it("records generated concerns before task creation and excludes no-issue results", () => {
    expect(
      statusRecords({
        ...base,
        sk: "CHECK#c#ANALYSIS#a",
        checkId: "c",
        analyzedAt: "2026-10-24T18:00:00Z",
        status: "analyzed",
        concerns: [
          { conditionId: "one", rating: 1, category: "litter" },
          { conditionId: "two", rating: 0 },
        ],
      }),
    ).toHaveLength(1);
    expect(
      statusRecords({
        ...base,
        sk: "TASK#one",
        createdAt: "2026-10-24T18:00:00Z",
        supersessionReason: "analysis_condition_amended",
      }),
    ).toEqual([]);
  });
  it("counts explicit deletion receipts and real actions but not automatic duplicate events", () => {
    const at = "2026-10-24T18:00:00Z";
    expect(
      statusRecords({ ...base, sk: "ISSUE_DELETION#c:one", deletedAt: at })[0]
        .kind,
    ).toBe("deletions");
    const update = {
      ...base,
      sk: `TASK#one#UPDATE#${at}#u`,
      occurredAt: at,
      updateId: "u",
      type: "note_photo_update",
    };
    expect(statusRecords(update)[0].kind).toBe("actions");
    expect(statusRecords({ ...update, actionSourceTaskId: "other" })).toEqual(
      [],
    );
    expect(statusRecords({ ...update, type: "duplicate_linked" })).toEqual([]);
    expect(
      statusRecords({
        ...base,
        sk: "CARE_WORK#w",
        workId: "w",
        createdAt: at,
        kind: "power_washed",
      })[0].category,
    ).toBe("power_washed");
  });
  it("counts perimeter checks by start time and excludes single-problem reports", () => {
    const check = {
      ...base,
      sk: "CHECK#c",
      checkId: "c",
      startedAt: "2026-10-24T18:00:00Z",
      completedAt: "2026-10-25T08:00:00Z",
      status: "completed",
      flowType: "perimeter",
    };
    expect(statusRecords(check)[0]).toMatchObject({
      at: check.startedAt,
      status: "completed",
    });
    expect(statusRecords({ ...check, flowType: "single-problem" })).toEqual([]);
  });
});

// The reporting writer must tolerate Stream retries without either double
// counting or acknowledging unrelated storage failures.

describe("reporting stream replay", () => {
  const issue = {
    ...base,
    sk: "CHECK#c#ANALYSIS#a",
    checkId: "c",
    artifactId: "a",
    analyzedAt: "2026-10-24T18:00:00Z",
    status: "analyzed",
    concerns: [{ conditionId: "one", rating: 1, category: "Graffiti" }],
  };
  it("atomically stores a guard and first generation event", async () => {
    send.mockResolvedValue({});
    await projectStatus(issue);
    const writes = send.mock.calls[0][0].input.TransactItems;
    expect(writes[0].Put.Item.sk).toBe("SEEN#issues#c:a:one");
    expect(writes[0].Put.ConditionExpression).toBe("attribute_not_exists(sk)");
    expect(writes[1].Put.Item).toMatchObject({
      kind: "issues",
      category: "Graffiti",
    });
  });
  it("acknowledges a repeated issue but retries other transaction failures", async () => {
    const duplicate = Object.assign(new Error("exists"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "ConditionalCheckFailed" },
        { Code: "None" },
      ],
    });
    send.mockRejectedValueOnce(duplicate);
    await expect(projectStatus(issue)).resolves.toBeUndefined();
    const outage = Object.assign(new Error("unavailable"), {
      name: "ProvisionedThroughputExceededException",
    });
    send.mockRejectedValueOnce(outage);
    await expect(projectStatus(issue)).rejects.toThrow("unavailable");
  });
  it("prevents an older stream image from reverting a completed check", async () => {
    send.mockResolvedValue({});
    await projectStatus({
      ...base,
      sk: "CHECK#c",
      checkId: "c",
      startedAt: "2026-10-24T18:00:00Z",
      completedAt: "2026-10-24T18:15:00Z",
      status: "completed",
    });
    const write = send.mock.calls[0][0].input;
    expect(write.ConditionExpression).toContain("#version <= :version");
    expect(write.ExpressionAttributeValues[":version"]).toBe(
      "2026-10-24T18:15:00Z",
    );
  });
});

it("counts legacy concerns without IDs and keeps matching IDs on different photos distinct", () => {
  const source = {
    pk: "SITE#one",
    sk: "CHECK#c#ANALYSIS#a",
    checkId: "c",
    artifactId: "a",
    status: "analyzed",
    analyzedAt: "2026-10-24T18:00:00Z",
    concerns: [
      { rating: 1, category: "Litter" },
      { conditionId: "shared", rating: 2, category: "Graffiti" },
    ],
  };
  const rows = statusRecords(source);
  expect(rows).toHaveLength(2);
  expect(rows[0].issueId).toBe("c:a:a-001-litter");
  expect(statusRecords({ ...source, artifactId: "b" })[1].issueId).not.toBe(
    rows[1].issueId,
  );
});
