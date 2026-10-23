// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Exercise the executable command with a fake npx, so failed-test behavior
// cannot launch browsers or leave a report server running in the test suite.
/** @param {string[]} args */
function invoke(args, status = 0) {
  const dir = mkdtempSync(join(tmpdir(), "a11y-report-command-"));
  const log = join(dir, "calls.jsonl");
  try {
    writeFileSync(
      join(dir, "npx"),
      String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.A11Y_TEST_LOG, JSON.stringify({args, open: process.env.PLAYWRIGHT_HTML_OPEN}) + '\n');
process.exit(args[1] === 'test' ? Number(process.env.A11Y_TEST_EXIT) : 0);
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./a11y-report.mjs", import.meta.url)), ...args],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${dir}${delimiter}${process.env.PATH}`,
          A11Y_TEST_LOG: log,
          A11Y_TEST_EXIT: String(status),
          PLAYWRIGHT_HTML_OPEN: "always",
        },
      },
    );
    assert.equal(result.error, undefined);
    return {
      status: result.status,
      calls: readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const options = { skip: process.platform === "win32" };
test(
  "default failing scan suppresses HTML auto-open, then opens only the screenshot report",
  options,
  () => {
    const { status, calls } = invoke(["--grep", "bound home"], 1);
    assert.equal(status, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].open, "never");
    assert.deepEqual(calls[0].args, [
      "playwright",
      "test",
      "tests/a11y.e2e.spec.js",
      "--reporter=list,html,ramp-check/reporter",
      "--grep",
      "bound home",
    ]);
    assert.deepEqual(calls[1].args, [
      "playwright",
      "show-report",
      "ramp-check-report",
    ]);
  },
);
for (const args of [
  ["--reporter=dot"],
  ["--reporter", "dot"],
  ["--reporter=html,ramp-check/reporter"],
]) {
  test(`caller controls reporter selection: ${args.join(" ")}`, options, () => {
    const { status, calls } = invoke(args);
    assert.equal(status, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].open, "never");
    assert.deepEqual(calls[0].args, [
      "playwright",
      "test",
      "tests/a11y.e2e.spec.js",
      ...args,
    ]);
  });
}
test(
  "a custom reporter preserves a failing exit status without opening a stale report",
  options,
  () => {
    const { status, calls } = invoke(["--reporter=dot"], 1);
    assert.equal(status, 1);
    assert.equal(calls.length, 1);
  },
);
