import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("publishes retained assets before HTML and stops on failed resource uploads", () => {
  const dir = mkdtempSync(join(tmpdir(), "publish-web-"));
  try {
    const log = join(dir, "calls");
    writeFileSync(
      join(dir, "aws"),
      '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.CALL_LOG, JSON.stringify(process.argv.slice(2))+"\\n"); if(process.env.FAIL_UPLOAD) process.exit(1);',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      CALL_LOG: log,
    };
    const run = (extra = {}) =>
      spawnSync(
        "bash",
        [resolve("scripts/publish-web-assets.sh"), "dist", "s3://test"],
        { env: { ...env, ...extra } },
      );
    assert.equal(run().status, 0);
    const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].slice(0, 4), [
      "s3",
      "sync",
      "dist/assets",
      "s3://test/assets",
    ]);
    assert.ok(calls[0].includes("*.map"));
    assert.ok(calls[1].includes("*.html"));
    assert.deepEqual(calls[2].slice(4), [
      "--exclude",
      "*",
      "--include",
      "*.html",
      "--cache-control",
      "no-cache",
    ]);
    assert.ok(calls.every((call) => !call.includes("--delete")));
    writeFileSync(log, "");
    assert.equal(run({ FAIL_UPLOAD: "1" }).status, 1);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
