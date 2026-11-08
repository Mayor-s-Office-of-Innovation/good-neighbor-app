import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const filter = fileURLToPath(new URL("./plan-diagnostics.jq", import.meta.url));

/** @param {string[]} lines what `terraform plan -json` wrote to stdout and stderr */
function diagnostics(lines) {
  const result = spawnSync("jq", ["-R", "-r", "-f", filter], {
    input: lines.join("\n"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean);
}

const SECRET = "s3cr3t-value";

test("prints each error's level, summary, address and line, so a maintainer can find it", () => {
  const out = diagnostics([
    JSON.stringify({
      type: "diagnostic",
      diagnostic: {
        severity: "error",
        summary: "reading Lambda Function (analysis): AccessDeniedException",
        detail: `TOKEN=${SECRET}`,
        address: "module.app.aws_lambda_function.analysis",
        range: {
          filename: "../../modules/app/analysis-worker.tf",
          start: { line: 36 },
        },
        snippet: { code: `TOKEN = "${SECRET}"` },
      },
    }),
  ]);
  assert.deepEqual(out, [
    "error\treading Lambda Function (analysis): AccessDeniedException\tmodule.app.aws_lambda_function.analysis\t../../modules/app/analysis-worker.tf:36",
  ]);
});

test("cuts quoted text from a summary, since it can hold a value from state", () => {
  const out = diagnostics([
    JSON.stringify({
      type: "diagnostic",
      diagnostic: {
        severity: "warning",
        summary: `invalid value "${SECRET}" for 'name ${SECRET}'`,
      },
    }),
  ]);
  assert.deepEqual(out, ["warning\tinvalid value \"…\"\t-\t-"]);
});

test("drops planned changes and other messages, which carry attribute values", () => {
  const out = diagnostics([
    JSON.stringify({ type: "version", terraform: "1.9.8" }),
    JSON.stringify({
      type: "planned_change",
      change: {
        resource: { addr: "aws_lambda_function.b" },
        after: { TOKEN: SECRET },
      },
    }),
    JSON.stringify({ type: "change_summary", changes: { add: 1 } }),
  ]);
  assert.deepEqual(out, []);
});

test("keeps only the error line of anything Terraform wrote as plain text", () => {
  const out = diagnostics([
    "│ Error: Failed to load plugin schemas",
    `│ Value was "${SECRET}" here`,
    "not json {",
    "42",
  ]);
  assert.deepEqual(out, ["│ Error: Failed to load plugin schemas"]);
});

test("cuts quoted keys from an address, since for_each keys can hold a value", () => {
  const out = diagnostics([
    JSON.stringify({
      type: "diagnostic",
      diagnostic: {
        severity: "error",
        summary: "reading SSM Parameter",
        address: `module.app.aws_ssm_parameter.token["${SECRET}"]`,
      },
    }),
  ]);
  assert.deepEqual(out, [
    'error\treading SSM Parameter\tmodule.app.aws_ssm_parameter.token["…"]\t-',
  ]);
});

/** @param {string} summary */
function summaryOut(summary) {
  return diagnostics([
    JSON.stringify({ type: "diagnostic", diagnostic: { severity: "error", summary } }),
  ]);
}

test("cuts a quoted value whole when it holds an escaped quote", () => {
  assert.deepEqual(summaryOut(`bad value "a\\"${SECRET}" and 'b\\'${SECRET}'`), [
    'error\tbad value "…"\t-\t-',
  ]);
});

test("cuts a single-quoted value that ends in a backslash", () => {
  assert.deepEqual(summaryOut(`Value '${SECRET}\\' failed`), ["error\tValue '…' failed\t-\t-"]);
});

test("cuts every quoted value after one that ends in a backslash", () => {
  assert.deepEqual(summaryOut(`x "a\\" and "${SECRET}" y`), ['error\tx "…" y\t-\t-']);
});

test("cuts to the end of the line after an unmatched quote", () => {
  assert.deepEqual(summaryOut(`Value '${SECRET} failed`), ["error\tValue '…\t-\t-"]);
});

test("cuts quoted text that spans a newline", () => {
  assert.deepEqual(summaryOut(`Value "a\n${SECRET}" failed`), ['error\tValue "…" failed\t-\t-']);
});

test("cuts quoted text from a plain-text error line", () => {
  assert.deepEqual(diagnostics([`│ Error: Value '${SECRET}\\' failed`]), [
    "│ Error: Value '…' failed",
  ]);
});
