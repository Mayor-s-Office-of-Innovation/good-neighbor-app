import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const filter = fileURLToPath(new URL("./plan-diagnostics.jq", import.meta.url));

const PRIVATE_LINE =
  "Summaries are withheld from this public log; the last column names the error class. Full text needs a plan run with the plan role's own permissions, such as a maintainer assuming an equivalent read-only role.";

/**
 * @param {string[]} lines what `terraform plan -json` wrote to stdout and stderr
 * @param {string} [status] the plan's exit status, as plan-dev.yml passes it
 */
function diagnostics(lines, status = "0") {
  const result = spawnSync("jq", ["-n", "-R", "-r", "--arg", "status", status, "-f", filter], {
    input: lines.join("\n"),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean);
}

const SECRET = "s3cr3t-value";

/**
 * @param {Record<string, unknown>} diagnostic
 */
function diagnosticLine(diagnostic) {
  return JSON.stringify({ type: "diagnostic", diagnostic });
}

test("prints each error's level, address and line, then how to read the rest", () => {
  const out = diagnostics([
    diagnosticLine({
      severity: "error",
      summary: "reading Lambda Function (analysis): AccessDeniedException",
      detail: `TOKEN=${SECRET}`,
      address: "module.app.aws_lambda_function.analysis",
      range: {
        filename: "../../modules/app/analysis-worker.tf",
        start: { line: 36 },
      },
      snippet: { code: `TOKEN = "${SECRET}"` },
    }),
  ]);
  assert.deepEqual(out, [
    "error\tmodule.app.aws_lambda_function.analysis\t../../modules/app/analysis-worker.tf:36\tAccessDeniedException",
    PRIVATE_LINE,
  ]);
});

for (const [name, summary] of [
  ["a backtick", `invalid value \`${SECRET}\``],
  ["curly quotes", `invalid value “${SECRET}”`],
  ["a parenthesised name", `creating IAM Role (${SECRET}): EntityAlreadyExists`],
  ["an apostrophe", `role's name ${SECRET} isn't valid`],
  ["an escaped quote", `bad value "a\\"${SECRET}" and 'b\\'${SECRET}'`],
  ["a trailing backslash", `Value '${SECRET}\\' failed`],
]) {
  test(`never prints a summary with ${name}`, () => {
    const out = diagnostics([diagnosticLine({ severity: "warning", summary, detail: summary })]);
    assert.deepEqual(out, ["warning\t-\t-\t-", PRIVATE_LINE]);
    assert.ok(!out.join("\n").includes(SECRET));
  });

  test(`never prints a plain-text error line with ${name}`, () => {
    const out = diagnostics([`│ Error: ${summary}`]);
    assert.deepEqual(out, ["error\t-\t-\t-", PRIVATE_LINE]);
  });
}

for (const [name, address, expected] of [
  ["a quoted key", `module.app.aws_ssm_parameter.token["${SECRET}"]`, "module.app.aws_ssm_parameter.token[…]"],
  ["a count key", "module.app.aws_iam_role.r[3]", "module.app.aws_iam_role.r[…]"],
  [
    "module and resource keys",
    `module.app["${SECRET}"].aws_iam_role.r["${SECRET}"]`,
    "module.app[…].aws_iam_role.r[…]",
  ],
  ["a key with an escaped quote", `aws_iam_role.r["a\\"]${SECRET}"]`, "aws_iam_role.r[…]"],
  ["an unclosed key", `aws_iam_role.r["${SECRET}`, "aws_iam_role.r[…]"],
  ["text outside the brackets", `aws_iam_role.r["a"] ${SECRET}: bad`, "-"],
  ["an object", { name: SECRET }, "-"],
]) {
  test(`cuts ${name} from an address, since for_each and count keys can hold a value`, () => {
    const out = diagnostics([diagnosticLine({ severity: "error", summary: "x", address })]);
    assert.deepEqual(out, [`error\t${expected}\t-\t-`, PRIVATE_LINE]);
  });
}

for (const [name, filename] of [
  ["an absolute path", "/home/runner/work/main.tf"],
  ["a space", `modules/${SECRET} x.tf`],
  ["a non-.tf file", `modules/${SECRET}.tfvars`],
  ["a number", 42],
]) {
  test(`prints - for a filename with ${name}`, () => {
    const out = diagnostics([
      diagnosticLine({ severity: "error", summary: "x", range: { filename, start: { line: 3 } } }),
    ]);
    assert.deepEqual(out, ["error\t-\t-\t-", PRIVATE_LINE]);
  });
}

test("prints - for a range that is a string, and keeps the other columns", () => {
  const out = diagnostics([
    diagnosticLine({ severity: "warning", summary: "x", address: "aws_iam_role.r", range: SECRET }),
  ]);
  assert.deepEqual(out, ["warning\taws_iam_role.r\t-\t-", PRIVATE_LINE]);
});

test("prints a fixed line for a malformed diagnostic and keeps the others", () => {
  const out = diagnostics([
    JSON.stringify({ type: "diagnostic", diagnostic: SECRET }),
    diagnosticLine({ severity: "error", summary: "x", address: "aws_iam_role.r" }),
  ]);
  assert.deepEqual(out, ["error\t-\t-\t-", "error\taws_iam_role.r\t-\t-", PRIVATE_LINE]);
});

for (const [summary, expected] of [
  [`reading IAM Role (${SECRET}): AccessDenied: not authorized`, "AccessDenied"],
  [`operation error Lambda: GetFunction, AccessDeniedException: ${SECRET}`, "AccessDeniedException"],
  [`UnauthorizedOperation: ${SECRET}`, "UnauthorizedOperation"],
  [`ResourceNotFoundException: ${SECRET}`, "ResourceNotFoundException"],
  [`NoSuchEntity: role ${SECRET}`, "NoSuchEntity"],
  [`ThrottlingException: Rate exceeded`, "ThrottlingException"],
  [`ExpiredToken: ${SECRET}`, "ExpiredToken"],
  [`InvalidClientTokenId: ${SECRET}`, "InvalidClientTokenId"],
  [`ValidationException: ${SECRET}`, "ValidationException"],
  [`Invalid value for ${SECRET}`, "-"],
  [`MyAccessDeniedThing ${SECRET}`, "-"],
]) {
  test(`prints ${expected === "-" ? "- for an unmatched" : `only the class ${expected} from a`} summary`, () => {
    const out = diagnostics([diagnosticLine({ severity: "error", summary })]);
    assert.deepEqual(out, [`error\t-\t-\t${expected}`, PRIVATE_LINE]);
  });
}

test("strips colour codes before reading an Error: line", () => {
  const out = diagnostics([`\u001b[31m╷\u001b[0m`, `\u001b[31m│\u001b[0m \u001b[1m\u001b[31mError: \u001b[0m\u001b[0m${SECRET}`]);
  assert.deepEqual(out, ["error\t-\t-\t-", PRIVATE_LINE]);
});

test("prints how to read errors when the plan fails with nothing recognised", () => {
  assert.deepEqual(diagnostics([`panic: ${SECRET}`], "1"), [PRIVATE_LINE]);
  assert.deepEqual(diagnostics([], "0"), []);
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
    `│ Value was "${SECRET}" here`,
    "not json {",
    "42",
  ]);
  assert.deepEqual(out, []);
});
