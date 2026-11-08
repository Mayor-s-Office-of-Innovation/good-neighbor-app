import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./tf-init-retry.sh", import.meta.url));

/**
 * @param {number[]} statuses exit status of each terraform call, in order
 * @param {string[]} [args]
 * @param {string[]} [outputs] what each terraform call prints, in order
 */
function run(statuses, args = [], outputs = []) {
  const directory = mkdtempSync(join(tmpdir(), "gn-tf-init-test-"));
  try {
    const log = join(directory, "calls");
    writeFileSync(log, "");
    outputs.forEach((output, i) => writeFileSync(join(directory, `out${i + 1}`), output));
    writeFileSync(
      join(directory, "terraform"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TF_TEST_LOG"
calls=$(wc -l < "$TF_TEST_LOG" | tr -d ' ')
[ ! -f "$TF_TEST_DIR/out$calls" ] || cat "$TF_TEST_DIR/out$calls"
set -- $TF_TEST_STATUSES
shift $((calls - 1))
exit "$1"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TF_INIT_RETRY_DELAY: "0",
        TF_TEST_LOG: log,
        TF_TEST_DIR: directory,
        TF_TEST_STATUSES: statuses.join(" "),
      },
    });
    return {
      status: result.status,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      stdout: result.stdout,
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

test("passes its arguments after -backend=false, as CI's callers expect", () => {
  const { status, calls } = run([0], ["-upgrade"]);
  assert.equal(status, 0);
  assert.deepEqual(calls, ["init -backend=false -upgrade"]);
});

test("inits with the backend only after --backend, as plan-dev.yml asks", () => {
  const { status, calls, stdout } = run([1, 0], ["--backend", "-input=false", "-json"]);
  assert.equal(status, 0);
  assert.deepEqual(calls, Array(2).fill("init -input=false -json"));
  assert.equal(stdout, "Terraform initialization failed; retrying in 0 seconds (attempt 1/3).\n");
});

/** @param {Record<string, unknown>} diagnostic */
const diagnosticLine = (diagnostic) => JSON.stringify({ type: "diagnostic", diagnostic }) + "\n";
const chain = (name) =>
  `operation error STS: GetCallerIdentity, https response error StatusCode: 403, RequestID: 1a2b, api error ${name}: x`;

for (const [name, output] of [
  ["a permission failure", diagnosticLine({ severity: "error", summary: `validating provider credentials: ${chain("AccessDenied")}` })],
  ["an expired token", diagnosticLine({ severity: "error", summary: "x", detail: chain("ExpiredToken") })],
  [
    "a bad backend block",
    diagnosticLine({ severity: "error", summary: "Unsupported argument", range: { filename: "main.tf", start: { line: 4 } } }),
  ],
]) {
  test(`runs a --backend init once for ${name}, since a retry can't pass`, () => {
    const { status, calls, stdout } = run([1, 0], ["--backend", "-json"], [output]);
    assert.equal(status, 1);
    assert.equal(calls.length, 1);
    assert.equal(stdout, output);
  });
}

for (const [name, output] of [
  [
    "a registry reset",
    diagnosticLine({
      severity: "error",
      summary: "Failed to query available provider packages",
      detail: "Could not retrieve the list of available versions for provider hashicorp/aws: read: connection reset by peer",
    }),
  ],
  ["throttling", diagnosticLine({ severity: "error", summary: chain("ThrottlingException") })],
]) {
  test(`retries a --backend init after ${name}`, () => {
    const { status, calls } = run([1, 0], ["--backend", "-json"], [output]);
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
  });
}

test("still retries a permission failure without --backend, as CI did before", () => {
  const output = diagnosticLine({ severity: "error", summary: chain("AccessDenied") });
  const { status, calls } = run([1, 0], [], [output]);
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
});
