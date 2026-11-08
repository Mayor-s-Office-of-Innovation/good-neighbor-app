import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const filter = fileURLToPath(new URL("./plan-diagnostics.jq", import.meta.url));

const PRIVATE_LINE =
  "Summaries are withheld from this public log. Each error shows its level and error class, plus its resource address and file line where Terraform gives them. Config errors reproduce in a local plan with dev credentials. A permission failure shows its denial class but not the action: find the action from the class and the resource address.";

/**
 * @param {string[]} lines what `terraform init -json` or `terraform plan -json` wrote to stdout and stderr
 * @param {string} [status] the command's exit status, as run-filtered.sh passes it; most cases here fail
 */
function diagnostics(lines, status = "1") {
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

test("prints each error's level, address, file line and error class, then the hint line", () => {
  const out = diagnostics([
    diagnosticLine({
      severity: "error",
      summary:
        "reading Lambda Function (analysis): operation error Lambda: GetFunction, https response error StatusCode: 403, RequestID: 1a2b, api error AccessDeniedException: not authorized",
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
  ["an unclosed key", `aws_iam_role.r["${SECRET}`, "-"],
  ["text after a key", `a.b["x"]${SECRET}.c`, "-"],
  ["a bare word", "SECRETVALUE", "-"],
  ["a nested module", "module.app.module.queue[2].aws_sqs_queue.q", "module.app.module.queue[…].aws_sqs_queue.q"],
  ["a data source", "module.app.data.aws_iam_policy_document.p", "module.app.data.aws_iam_policy_document.p"],
  ["an indexed data source", `data.aws_ssm_parameter.p["${SECRET}"]`, "data.aws_ssm_parameter.p[…]"],
  ["text outside the brackets", `aws_iam_role.r["a"] ${SECRET}: bad`, "-"],
  ["an object", { name: SECRET }, "-"],
]) {
  test(`cuts ${name} from an address, since for_each and count keys can hold a value`, () => {
    const out = diagnostics([diagnosticLine({ severity: "error", summary: "x", address })]);
    assert.deepEqual(out, [`error\t${expected}\t-\t-`, PRIVATE_LINE]);
  });
}

test("keeps a relative .tf.json filename", () => {
  const out = diagnostics([
    diagnosticLine({ severity: "error", summary: "x", range: { filename: "modules/app/main.tf.json", start: { line: 3 } } }),
  ]);
  assert.deepEqual(out, ["error\t-\tmodules/app/main.tf.json:3\t-", PRIVATE_LINE]);
});

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

const op = "operation error IAM: GetRole, https response error StatusCode: 403, RequestID: 1a2b";

for (const [name, summary, expected] of [
  ["a name quoted before the chain", `reading IAM Role (${SECRET}): ${op}, api error AccessDenied: not authorized`, "AccessDenied"],
  ["an api error", `${op}, api error AccessDeniedException: ${SECRET}`, "AccessDeniedException"],
  ["an EC2 denial", `${op}, api error UnauthorizedOperation: ${SECRET}`, "UnauthorizedOperation"],
  ["a code with no api error label", `${op}, ResourceNotFoundException: ${SECRET}`, "ResourceNotFoundException"],
  ["an IAM code with no label", `${op}, NoSuchEntity: role ${SECRET}`, "NoSuchEntity"],
  ["throttling", `${op}, api error ThrottlingException: Rate exceeded`, "ThrottlingException"],
  ["an expired token", `${op}, api error ExpiredToken: ${SECRET}`, "ExpiredToken"],
  ["an expired token exception", `${op}, api error ExpiredTokenException: ${SECRET}`, "ExpiredTokenException"],
  ["an invalid token", `${op}, api error InvalidClientTokenId: ${SECRET}`, "InvalidClientTokenId"],
  ["a validation error", `${op}, api error ValidationException: ${SECRET}`, "ValidationException"],
  ["a 403 Forbidden", `${op}, api error Forbidden: ${SECRET}`, "Forbidden"],
  ["an SNS denial", `${op}, api error AuthorizationError: ${SECRET}`, "AuthorizationError"],
  ["an unrecognised client", `${op}, api error UnrecognizedClientException: ${SECRET}`, "UnrecognizedClientException"],
  ["an unknown key", `${op}, api error InvalidAccessKeyId: ${SECRET}`, "InvalidAccessKeyId"],
  ["a bad signature", `${op}, api error SignatureDoesNotMatch: ${SECRET}`, "SignatureDoesNotMatch"],
  [
    "an S3 chain with a HostID",
    `operation error S3: HeadBucket, https response error StatusCode: 404, RequestID: 1a2b, HostID: c3d4, NoSuchBucket: ${SECRET}`,
    "NoSuchBucket",
  ],
  [
    "a chain after retries ran out",
    `operation error CloudWatch Logs: DescribeLogGroups, exceeded maximum number of attempts, 3, https response error StatusCode: 400, RequestID: 1a2b, api error ThrottlingException: ${SECRET}`,
    "ThrottlingException",
  ],
  ["two chains, of which the first wins", `${op}, api error NotFound: x ${SECRET}: api error AccessDenied: y`, "NotFound"],
  ["no chain", `Invalid value for ${SECRET}`, "-"],
  ["a class name inside a word", `MyAccessDeniedThing ${SECRET}`, "-"],
  ["a class name with no chain", `AccessDenied: ${SECRET}`, "-"],
  ["a class name inside a quoted value", `invalid value "x-NotFound-y"`, "-"],
  ["a chain followed by a quoted value", `${op}, invalid value "x-NotFound-y"`, "-"],
  ["an api error label inside a quoted value", `Invalid value "api error Forbidden: "`, "-"],
  ["an api error label after an unrelated chain prefix", `operation error ${SECRET}, api error Forbidden: x`, "-"],
]) {
  test(`prints the error class ${expected} for ${name}`, () => {
    const out = diagnostics([diagnosticLine({ severity: "error", summary })]);
    assert.deepEqual(out, [`error\t-\t-\t${expected}`, PRIVATE_LINE]);
  });
}

test("reads the error class from the detail with the same position rule", () => {
  const out = diagnostics([
    diagnosticLine({ severity: "error", summary: "reading IAM Role (r)", detail: `${op}, api error AccessDenied: ${SECRET}` }),
    diagnosticLine({ severity: "error", summary: "x", detail: `value "x-NotFound-y" ${SECRET}` }),
  ]);
  assert.deepEqual(out, ["error\t-\t-\tAccessDenied", "error\t-\t-\t-", PRIVATE_LINE]);
});

test("reads the error class from a plain-text Error: line, such as an init backend error", () => {
  const out = diagnostics([
    `│ Error: Failed to get existing workspaces: Unable to list objects in S3 bucket "${SECRET}": operation error S3: ListObjectsV2, https response error StatusCode: 403, RequestID: 1a2b, HostID: c3d4, api error AccessDenied: Access Denied`,
    `Warning: ${SECRET} api error AccessDenied: x`,
  ]);
  assert.deepEqual(out, ["error\t-\t-\tAccessDenied", "warning\t-\t-\t-", PRIVATE_LINE]);
});

test("reads the error class from the detail lines of a plain-text error, joined across wrapped lines", () => {
  const out = diagnostics([
    "╷",
    "│ Error: Failed to get existing workspaces",
    "│ ",
    "│   with terraform.backend \"s3\",",
    "│   on main.tf line 2, in terraform:",
    `│    2:   backend "s3" { bucket = "${SECRET}" }`,
    "│ ",
    `│ Unable to list objects in S3 bucket "${SECRET}" with prefix "env:/":`,
    "│ operation error S3: ListObjectsV2, https response error StatusCode: 403,",
    "│ RequestID: 1A2B3C, HostID: c3d4e5, api error AccessDenied: Access Denied",
    "│ ",
    `│ Error: ${SECRET}`,
    "│ ",
    "│ operation error STS: GetCallerIdentity, https response error StatusCode:",
    `│ 403, RequestID: 9f8e, api error ExpiredToken: ${SECRET}`,
    "╵",
    `│ ${SECRET} api error Forbidden: x`,
    "Error: Unreadable",
    "",
    "operation error STS: GetCallerIdentity, https response error StatusCode: 403, RequestID: 9f8e, api error ExpiredToken: x",
  ]);
  assert.deepEqual(out, ["error\t-\t-\tAccessDenied", "error\t-\t-\tExpiredToken", "error\t-\t-\t-", PRIVATE_LINE]);
  assert.ok(!out.join("\n").includes(SECRET));
});

test("shows the hint only when the step fails, so a green init after a retry has none", () => {
  const out = diagnostics(
    [
      `│ Error: Failed to query available provider packages: ${SECRET}`,
      "Terraform initialization failed; retrying in 10 seconds (attempt 1/3).",
      JSON.stringify({ type: "log", "@message": "Installed provider version: hashicorp/aws v6.71.0 (signed by HashiCorp)" }),
      diagnosticLine({ severity: "warning", summary: SECRET }),
    ],
    "0",
  );
  assert.deepEqual(out, [
    "error\t-\t-\t-",
    "Terraform initialization failed; retrying in 10 seconds (attempt 1/3).",
    "Provider: hashicorp/aws v6.71.0",
    "warning\t-\t-\t-",
  ]);
});

test("prints a pre-release provider version", () => {
  /** @param {string} message */
  const log = (message) => JSON.stringify({ type: "log", "@message": message });
  const out = diagnostics(
    [
      log("Installed provider version: hashicorp/aws v6.0.0-beta1 (signed by HashiCorp)"),
      log("hashicorp/random v3.7.0-rc.2: Using previously-installed provider version"),
      log(`Installed provider version: hashicorp/null v3.2.3-${SECRET}!`),
    ],
    "0",
  );
  assert.deepEqual(out, ["Provider: hashicorp/aws v6.0.0-beta1", "Provider: hashicorp/random v3.7.0-rc.2"]);
});

test("drops a pre-release suffix that isn't alpha, beta, rc, dev or pre", () => {
  /** @param {string} message */
  const log = (message) => JSON.stringify({ type: "log", "@message": message });
  const out = diagnostics(
    [
      log("Installed provider version: hashicorp/null v3.2.3-abcDEF.secret-token (signed by HashiCorp)"),
      log("hashicorp/null v3.2.3-abcDEF.secret-token: Using previously-installed provider version"),
    ],
    "0",
  );
  assert.deepEqual(out, []);
});

test("reads the error class from an init -json backend diagnostic", () => {
  const out = diagnostics(
    [
      JSON.stringify({ type: "init_output", message_code: "initializing_backend_message", "@message": "Initializing the backend..." }),
      diagnosticLine({
        severity: "error",
        summary: `validating provider credentials: retrieving caller identity from STS: operation error STS: GetCallerIdentity, https response error StatusCode: 403, RequestID: 2dfa, api error InvalidClientTokenId: ${SECRET}`,
        detail: "",
      }),
    ],
    "1",
  );
  assert.deepEqual(out, ["error\t-\t-\tInvalidClientTokenId", PRIVATE_LINE]);
});

test("prints installed provider versions and lock file changes from a successful init, without the hint", () => {
  /** @param {string} type @param {string} message @param {string} [code] */
  const ui = (type, message, code) => JSON.stringify({ type, "@message": message, message_code: code });
  const out = diagnostics([
    JSON.stringify({ type: "version", terraform: "1.9.8" }),
    ui("init_output", "Initializing provider plugins...", "initializing_provider_plugin_message"),
    ui("log", "hashicorp/aws: Reusing previous version from the dependency lock file"),
    ui("log", "Installing provider version: hashicorp/aws v6.71.0..."),
    ui("log", "Installed provider version: hashicorp/aws v6.71.0 (signed by HashiCorp)"),
    ui("log", `Installed provider version: hashicorp/archive v2.7.1 ${SECRET}`),
    ui("log", `Installed provider version: hashicorp/null v3.2.3${SECRET}`),
    ui("log", "hashicorp/random v3.6.0: Using previously-installed provider version"),
    ui("log", `hashicorp/random v3.6.0: Using previously-installed provider version ${SECRET}`),
    ui("log", `Finding matching versions for provider: hashicorp/aws, version_constraint: "${SECRET}"`),
    ui("init_output", "Terraform has created a lock file .terraform.lock.hcl ...", "lock_info"),
    ui("init_output", "Terraform has made some changes ...", "dependencies_lock_changes_info"),
    ui("init_output", `${SECRET}`, "output_init_success_cli_message"),
    JSON.stringify({ type: "log", "@message": { text: SECRET } }),
    JSON.stringify({ type: "init_output", "@message": SECRET, message_code: { code: "lock_info" } }),
  ], "0");
  assert.deepEqual(out, [
    "Provider: hashicorp/aws v6.71.0",
    "Provider: hashicorp/archive v2.7.1",
    "Provider: hashicorp/random v3.6.0",
    "Lock file: created .terraform.lock.hcl",
    "Lock file: provider selections changed in .terraform.lock.hcl",
  ]);
});

test("prints tf-init-retry.sh's retry line, so repeated init errors read as retries", () => {
  const out = diagnostics(
    [
      "Terraform initialization failed; retrying in 10 seconds (attempt 1/3).",
      `Terraform initialization failed; retrying in 10 seconds (attempt 1/3). ${SECRET}`,
    ],
    "0",
  );
  assert.deepEqual(out, ["Terraform initialization failed; retrying in 10 seconds (attempt 1/3)."]);
});

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
  ], "0");
  assert.deepEqual(out, []);
});
