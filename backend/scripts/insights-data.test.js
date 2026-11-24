import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "insights-data.mjs");
/** @type {string[]} */
const made = [];

afterEach(async () => {
  await Promise.all(
    made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("insights-data --out", () => {
  it("refuses a folder it didn't write, even one holding a check.json", async () => {
    const out = await mkdtemp(join(tmpdir(), "insights-data-out-"));
    made.push(out);
    await writeFile(join(out, "check.json"), "{}");
    await writeFile(join(out, "notes.txt"), "keep me");
    // --sites 0 stops the run just after the folder check, before any emulator starts.
    const result = await run(process.execPath, [
      script,
      "--out",
      out,
      "--sites",
      "0",
    ]).catch((/** @type {any} */ err) => err);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("has other files");
  });
});
