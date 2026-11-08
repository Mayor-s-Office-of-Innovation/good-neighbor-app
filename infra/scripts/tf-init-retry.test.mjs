import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./tf-init-retry.sh", import.meta.url));

/** @param {number[]} statuses exit status of each terraform call, in order */
function run(statuses) {
  const directory = mkdtempSync(join(tmpdir(), "gn-tf-init-test-"));
  try {
    const log = join(directory, "calls");
    writeFileSync(log, "");
    writeFileSync(
      join(directory, "terraform"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TF_TEST_LOG"
calls=$(wc -l < "$TF_TEST_LOG")
set -- $TF_TEST_STATUSES
shift $((calls - 1))
exit "$1"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TF_INIT_RETRY_DELAY: "0",
        TF_TEST_LOG: log,
        TF_TEST_STATUSES: statuses.join(" "),
      },
    });
    return {
      status: result.status,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("retries a failed init and succeeds on a later attempt", () => {
  const { status, calls } = run([1, 1, 0]);
  assert.equal(status, 0);
  assert.deepEqual(calls, Array(3).fill("init -backend=false"));
});

test("stops after three attempts with terraform's own exit status", () => {
  const { status, calls } = run([1, 1, 7]);
  assert.equal(status, 7);
  assert.equal(calls.length, 3);
});

test("doesn't retry an init that succeeds", () => {
  const { status, calls } = run([0]);
  assert.equal(status, 0);
  assert.equal(calls.length, 1);
});
