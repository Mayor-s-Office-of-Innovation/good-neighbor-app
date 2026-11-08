import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./run-filtered.sh", import.meta.url));
const SECRET = "s3cr3t-value";

/**
 * @param {string} command bash code standing in for a terraform call
 * @param {string} [logName] where the raw output goes, inside a fresh folder
 */
function run(command, logName = "out.log") {
  const directory = mkdtempSync(join(tmpdir(), "gn-run-filtered-test-"));
  try {
    const log = join(directory, logName);
    const result = spawnSync("bash", [script, log, "bash", "-c", command], { encoding: "utf8" });
    let raw = null;
    try {
      raw = readFileSync(log, "utf8");
    } catch {}
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, raw };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("keeps the raw output in the log file, prints only filtered lines and exits with the command's status", () => {
  const diagnostic = JSON.stringify({
    type: "diagnostic",
    diagnostic: { severity: "error", summary: SECRET, address: "aws_iam_role.r" },
  });
  const { status, stdout, stderr, raw } = run(`echo '${diagnostic}'; echo "${SECRET}" >&2; exit 3`);
  assert.equal(status, 3);
  assert.match(stdout, /^error\taws_iam_role\.r\t-\t-\n/);
  assert.ok(!stdout.includes(SECRET) && !stderr.includes(SECRET));
  assert.ok(raw.includes(SECRET));
});

test("prints nothing for a successful command with nothing allowlisted", () => {
  const { status, stdout, stderr } = run(`echo "${SECRET}"`);
  assert.equal(status, 0);
  assert.equal(stdout + stderr, "");
});

test("prints a fixed line and fails when the filter can't read the output", () => {
  const { status, stdout, stderr } = run(`echo "${SECRET}"`, "missing/out.log");
  assert.notEqual(status, 0);
  assert.ok(stdout.endsWith("\nCould not filter Terraform's output, so none of it is shown.\n"), stdout);
  assert.ok(!stderr.includes(SECRET));
});
