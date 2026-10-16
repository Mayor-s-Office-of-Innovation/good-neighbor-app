import { it, expect, vi, beforeEach } from "vitest";
import {
  analysisRevision,
  projectionKey,
} from "../analysis/duplicates/jobs.js";
const state = vi.hoisted(() => ({ site: "site", items: new Map() }));
vi.mock("../db.js", () => ({
  ddb: {
    send: async (
      /** @type {import('@aws-sdk/lib-dynamodb').GetCommand} */ cmd,
    ) => ({
      Item: state.items.get(`${cmd.input.Key?.pk}|${cmd.input.Key?.sk}`),
    }),
  },
}));
vi.mock("../config.js", () => ({ getConfig: () => ({ dynamoTable: "test" }) }));
vi.mock("../lib/principal.js", () => ({ deriveSiteId: () => state.site }));
import { getDuplicateResult } from "./duplicate-results.js";
/**
 * @param {Record<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue> & {pk:string,sk:string}} row
 * @returns {Map<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue>}
 */
const put = (row) => state.items.set(`${row.pk}|${row.sk}`, row);
const source = {
  pk: "SITE#site",
  sk: "CHECK#check#ANALYSIS#photo",
  status: "analyzed",
  analysisId: "source",
  analyzedAt: "2026-10-15T10:00:00Z",
  concerns: [
    { conditionId: "s1", category: "Litter", rating: 2, explanation: "pile" },
    { conditionId: "s2", category: "Litter", rating: 1, explanation: "other" },
  ],
};
const target = {
  pk: "SITE#site",
  sk: "CHECK#target#ANALYSIS#photo",
  status: "analyzed",
  analysisId: "target",
  analyzedAt: "2026-10-15T09:00:00Z",
  concerns: [
    { conditionId: "t1", category: "Litter", rating: 2, explanation: "pile" },
  ],
};
const artifact = {
  pk: "SITE#site",
  sk: "CHECK#check#ART#photo",
  capturedAt: "2026-10-15T10:00:00Z",
};
const revision = analysisRevision(source),
  targetRevision = analysisRevision(target);
const sourceProjection = {
  ...projectionKey("site", artifact.capturedAt, "check:photo"),
  revision,
};
const targetProjection = {
  ...projectionKey("site", "2026-10-15T09:00:00Z", "target:photo"),
  revision: targetRevision,
};
const event = /** @type {Parameters<typeof getDuplicateResult>[0]} */ (
  /** @type {unknown} */ ({
    pathParameters: { checkId: "check", artifactId: "photo" },
  })
);
/** @returns {Promise<Record<string,import("@aws-sdk/util-dynamodb").NativeAttributeValue>>} */
async function read() {
  const r = await getDuplicateResult(
    event,
    /** @type {import("aws-lambda").Context} */ (/** @type {unknown} */ ({})),
    () => {},
  );
  return JSON.parse(
    /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (r)
      .body ?? "{}",
  );
}
beforeEach(() => {
  state.items.clear();
  state.site = "site";
  process.env.DUPLICATE_DETECTION_ENABLED = "true";
  put(source);
  put(artifact);
  put(target);
  put(sourceProjection);
  put(targetProjection);
  put({ pk: "SITE#site", sk: "CHECK#target#ART#photo" });
});
it("returns pending before dispatch, never a fabricated negative", async () => {
  const r = await read();
  expect(r.processingState).toBe("pending");
  expect(r.possibleDuplicate).toBeNull();
  expect(
    r.conditionResults.every(
      (/** @type {{status:string}} */ c) => c.status === "pending",
    ),
  ).toBe(true);
});
it("returns a validated issue positive while another issue is pending, and revokes resolved targets", async () => {
  put({
    pk: "SITE#site",
    sk: `DUP_ISSUE#check:photo#${revision}#s1`,
    conditionId: "s1",
    status: "evaluated",
    possibleDuplicate: true,
    duplicateOf: {
      observationId: "target:photo",
      conditionId: "t1",
      revision: targetRevision,
    },
    matchStrength: "strong",
    targetProjectionKey: { pk: targetProjection.pk, sk: targetProjection.sk },
    targetAnalysisKey: { pk: target.pk, sk: target.sk },
    targetArtifactKey: { pk: "SITE#site", sk: "CHECK#target#ART#photo" },
    updatedAt: "2026-10-15T10:01:00Z",
  });
  const r = await read();
  expect(r.processingState).toBe("partial");
  expect(r.conditionResults[0].possibleDuplicate).toBe(true);
  expect(r.conditionResults[1].possibleDuplicate).toBeNull();
  put({ ...targetProjection, resolvedAt: "2026-10-15T10:02:00Z" });
  const stale = await read();
  expect(stale.possibleDuplicate).toBeNull();
  expect(stale.processingState).toBe("pending");
});
it("does not expose another sites artifact", async () => {
  state.site = "other";
  const r = await getDuplicateResult(
    event,
    /** @type {import("aws-lambda").Context} */ (/** @type {unknown} */ ({})),
    () => {},
  );
  expect(
    /** @type {import("aws-lambda").APIGatewayProxyStructuredResultV2} */ (r)
      .statusCode,
  ).toBe(404);
});
it("explicitly reports disabled detection", async () => {
  process.env.DUPLICATE_DETECTION_ENABLED = "false";
  expect((await read()).processingState).toBe("disabled");
});
it("does not leave a resolved source pending forever", async () => {
  put({ ...sourceProjection, resolvedAt: "2026-10-15T11:00:00Z" });
  const r = await read();
  expect(r.processingState).toBe("complete");
  expect(r.reason).toBe("source_resolved");
  expect(r.possibleDuplicate).toBeNull();
});
