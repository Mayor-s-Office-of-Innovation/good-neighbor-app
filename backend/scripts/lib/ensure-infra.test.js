import { it, expect, vi } from "vitest";
import {
  DescribeTableCommand,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  LOCAL_INSIGHTS_JOBS_BUCKET,
  TABLE_SCHEMA,
  applyLocalInsightsEnv,
  emulatedLakeBuckets,
  ensureLocalTableIndexes,
  insightsSeedDir,
} from "./ensure-infra.mjs";

/**
 * A DynamoDB Local stand-in whose table has every schema index except GSI3.
 * Any UpdateTable attempt makes the index appear, as if the winning process
 * created it; `updateError` is what this process's own attempt throws.
 * @param {{ updateError?: Error }} [options]
 */
function fakeTable({ updateError } = {}) {
  let created = false;
  const send = vi.fn(async (/** @type {any} */ command) => {
    if (command instanceof DescribeTableCommand) {
      const indexes = (TABLE_SCHEMA.GlobalSecondaryIndexes ?? [])
        .map((index) => index.IndexName)
        .filter((name) => name !== "GSI3" || created)
        .map((IndexName) => ({ IndexName, IndexStatus: "ACTIVE" }));
      return { Table: { GlobalSecondaryIndexes: indexes } };
    }
    if (command instanceof UpdateTableCommand) {
      created = true;
      if (updateError) throw updateError;
      return {};
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
  return { send };
}

it("creates the lake bucket only for a stack that reads the lake from MinIO", () => {
  expect(
    emulatedLakeBuckets({
      INSIGHTS_PROJECTION_DIR: "",
      LAKE_BUCKET: "e2e-lake",
    }),
  ).toEqual(["e2e-lake"]);
  // A developer's .env.local may name the real lake, which CreateBucket can't touch.
  expect(emulatedLakeBuckets({ LAKE_BUCKET: "real-lake" })).toEqual([]);
  expect(
    emulatedLakeBuckets({
      INSIGHTS_PROJECTION_DIR: "/tmp/projection",
      LAKE_BUCKET: "real-lake",
    }),
  ).toEqual([]);
  expect(emulatedLakeBuckets({ INSIGHTS_PROJECTION_DIR: "" })).toEqual([]);
});

it("adds a missing index with only its own attribute definitions and waits for it", async () => {
  const ddb = fakeTable();
  await ensureLocalTableIndexes(/** @type {any} */ (ddb), "gnp-local-app");
  const updates = ddb.send.mock.calls
    .map(([c]) => c)
    .filter((c) => c instanceof UpdateTableCommand);
  expect(updates).toHaveLength(1);
  expect(updates[0].input.GlobalSecondaryIndexUpdates).toEqual([
    { Create: expect.objectContaining({ IndexName: "GSI3" }) },
  ]);
  expect(
    updates[0].input.AttributeDefinitions.map((a) => a.AttributeName),
  ).toEqual(["gsi3pk", "gsi3sk"]);
});

it("tolerates another bootstrap process creating the same index first", async () => {
  for (const error of [
    Object.assign(new Error("Table is being updated"), {
      name: "ResourceInUseException",
    }),
    Object.assign(new Error("Index GSI3 already exists"), {
      name: "ValidationException",
    }),
  ]) {
    const ddb = fakeTable({ updateError: error });
    await expect(
      ensureLocalTableIndexes(/** @type {any} */ (ddb), "gnp-local-app"),
    ).resolves.toBeUndefined();
  }
});

it("still surfaces unrelated UpdateTable failures", async () => {
  const ddb = fakeTable({
    updateError: Object.assign(new Error("denied"), {
      name: "AccessDeniedException",
    }),
  });
  await expect(
    ensureLocalTableIndexes(/** @type {any} */ (ddb), "gnp-local-app"),
  ).rejects.toThrow("denied");
});

it("gives the local API and worker the same Insights folder and jobs bucket", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  applyLocalInsightsEnv(env);
  expect(env.INSIGHTS_PROJECTION_DIR).toMatch(
    /backend\/\.local\/insights-data\/projection$/,
  );
  expect(env.INSIGHTS_JOBS_BUCKET).toBe(LOCAL_INSIGHTS_JOBS_BUCKET);
});

it("keeps a blank projection folder and a named jobs bucket, as the emulator suite sets them", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = { INSIGHTS_PROJECTION_DIR: "", INSIGHTS_JOBS_BUCKET: "mine" };
  applyLocalInsightsEnv(env);
  expect(env).toEqual({
    INSIGHTS_PROJECTION_DIR: "",
    INSIGHTS_JOBS_BUCKET: "mine",
  });
});

it("finds the Insights seed files beside the projection, and none when the lake is in MinIO", () => {
  expect(insightsSeedDir({ INSIGHTS_PROJECTION_DIR: "/data/projection" })).toBe(
    "/data",
  );
  // dirname("") is ".", which would read names.json from wherever the API started.
  expect(insightsSeedDir({ INSIGHTS_PROJECTION_DIR: "" })).toBeNull();
});
