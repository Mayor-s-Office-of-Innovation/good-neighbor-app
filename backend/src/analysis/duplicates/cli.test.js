import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../../../scripts/evaluate-duplicates.mjs", import.meta.url),
);
/** @type {string[]} */
const directories = [];

/**
 * @returns {string}
 */
function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "duplicate-evaluation-"));
  directories.push(directory);
  return directory;
}

/**
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("duplicate experiment command", () => {
  it("runs development thresholds and marks synthetic output clearly", () => {
    const result = run([]);
    expect(result.status).toBe(0);
    const reports = JSON.parse(result.stdout);
    expect(reports).toHaveLength(3);
    expect(reports[0]).toMatchObject({ synthetic: true, split: "development" });
    expect(reports[0].warning).toContain("not field accuracy");
  });

  it("requires a frozen threshold for held-out evaluation", () => {
    expect(run(["--split", "test"]).status).toBe(1);
    const result = run(["--split", "test", "--thresholds", "0.35"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)[0].totals.cases).toBe(4);
    expect(run(["--thresholds", "NaN"]).status).toBe(1);
  });

  it("exports label-free prompts without overwriting an existing file", () => {
    const destination = join(temporaryDirectory(), "prompts.json");
    expect(run(["--prompts", destination]).status).toBe(0);
    const contents = readFileSync(destination, "utf8");
    const prompts = JSON.parse(contents);
    expect(prompts).toHaveLength(10);
    expect(contents).not.toContain("duplicateIds");
    expect(run(["--prompts", destination]).status).toBe(1);
    expect(readFileSync(destination, "utf8")).toBe(contents);
  });

  it("round-trips response batches and rejects missing or extra results", () => {
    const report = JSON.parse(run(["--thresholds", "0.35"]).stdout)[0];
    const predictions = report.rows.map(
      (/** @type {{sourceId: string, prediction: unknown}} */ row) => ({
        sourceId: row.sourceId,
        prediction: row.prediction,
      }),
    );
    const destination = join(temporaryDirectory(), "predictions.json");
    writeFileSync(destination, JSON.stringify(predictions));
    const result = run(["--predictions", destination]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)[0].metrics).toEqual(report.metrics);
    writeFileSync(destination, JSON.stringify(predictions.slice(1)));
    expect(run(["--predictions", destination]).status).toBe(1);
    writeFileSync(
      destination,
      JSON.stringify([...predictions, predictions[0]]),
    );
    expect(run(["--predictions", destination]).status).toBe(1);
  });
});
