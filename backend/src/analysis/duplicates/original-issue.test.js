import { it, expect } from "vitest";
import { findOriginalIssue } from "./original-issue.js";
import { analysisRevision, projectionKey } from "./jobs.js";
/** @typedef {Record<string,import('@aws-sdk/util-dynamodb').NativeAttributeValue>} Item */
function fixture() {
  /** @type {Map<string,Item>} */ const items = new Map();
  /** @param {Item} item */ const put = (item) => items.set(item.sk, item);
  /** @param {string} id @param {string} time */
  function add(id, time) {
    const analysis = {
      status: "analyzed",
      analysisId: id,
      analyzedAt: time,
      concerns: [
        {
          conditionId: "issue",
          category: "Litter",
          rating: 1,
          explanation: "pile",
        },
      ],
    };
    const revision = analysisRevision(analysis);
    put({ ...analysis, sk: `CHECK#${id}#ANALYSIS#photo` });
    put({ sk: `CHECK#${id}#ART#photo`, capturedAt: time });
    const key = projectionKey("site", time, `${id}:photo`);
    put({ ...key, revision });
    return { observationId: `${id}:photo`, conditionId: "issue", revision };
  }
  const old = add("old", "2026-10-01T10:00:00Z");
  const recent = add("recent", "2026-10-14T10:00:00Z");
  put({
    sk: `DUP_ISSUE#${recent.observationId}#${recent.revision}#issue`,
    possibleDuplicate: true,
    matchStrength: "strong",
    duplicateOf: old,
    updatedAt: "2026-10-14T11:00:00Z",
  });
  put({
    sk: `DUP_RESULT#${old.observationId}#${old.revision}`,
    conditionResults: [
      { conditionId: "issue", status: "evaluated", possibleDuplicate: false },
    ],
  });
  const input = {
    siteId: "site",
    category: "Litter",
    sourceTime: "2026-10-15T10:00:00Z",
    direct: recent,
    get: async (/** @type {{pk:string,sk:string}} */ key) =>
      key.pk === "SITE#site" ? items.get(key.sk) : undefined,
  };
  return { items, put, old, recent, input };
}
it("follows confirmed references beyond 72 hours without image analysis", async () => {
  const { input, old } = fixture();
  expect(await findOriginalIssue(input)).toEqual({
    originalIssue: old,
    originalLookupState: "complete",
  });
});
it.each(["category", "revision", "resolved", "deleted", "newer", "cycle"])(
  "rejects a %s chain",
  async (kind) => {
    const { input, items, put, old, recent } = fixture();
    if (kind === "category" || kind === "revision") {
      const sk = "CHECK#old#ANALYSIS#photo";
      const analysis = items.get(sk);
      if (analysis) {
        if (kind === "category") analysis.concerns[0].category = "Graffiti";
        else analysis.analysisId = "amended";
      }
    } else if (kind === "deleted") items.delete("CHECK#old#ART#photo");
    else if (kind === "resolved") {
      const key = projectionKey("site", "2026-10-01T10:00:00Z", "old:photo");
      put({
        ...items.get(key.sk),
        sk: key.sk,
        resolvedAt: "2026-10-02T00:00:00Z",
      });
    } else if (kind === "newer") {
      const row = items.get("CHECK#old#ANALYSIS#photo");
      if (row) row.analyzedAt = "2026-10-15T12:00:00Z";
    } else {
      put({
        sk: `DUP_ISSUE#${old.observationId}#${old.revision}#issue`,
        possibleDuplicate: true,
        matchStrength: "strong",
        duplicateOf: recent,
      });
    }
    expect((await findOriginalIssue(input)).originalIssue).toBeNull();
    expect((await findOriginalIssue(input)).originalLookupState).toBe(
      "invalid_chain",
    );
  },
);
it("does not invent an original while an ancestor is pending", async () => {
  const { input, items, old } = fixture();
  items.set(`DUP_RESULT#${old.observationId}#${old.revision}`, {
    status: "pending",
  });
  expect(await findOriginalIssue(input)).toEqual({
    originalIssue: null,
    originalLookupState: "pending",
  });
});
it("ignores invalidated incremental links", async () => {
  const { input, put, recent } = fixture();
  put({
    sk: `DUP_RESULT#${recent.observationId}#${recent.revision}`,
    invalidatedAt: "2026-10-15T00:00:00Z",
    conditionResults: [
      { conditionId: "issue", status: "evaluated", possibleDuplicate: false },
    ],
  });
  expect((await findOriginalIssue(input)).originalIssue).toEqual(recent);
});
