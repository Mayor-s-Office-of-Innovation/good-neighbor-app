import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const filter = fileURLToPath(new URL("./plan-summary.jq", import.meta.url));

/** @param {object} plan output of `terraform show -json` */
function summarize(plan) {
  const result = spawnSync("jq", ["-r", "-f", filter], {
    input: JSON.stringify(plan),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean);
}

const SECRET = "s3cr3t-value";
const plan = {
  resource_changes: [
    {
      address: "aws_lambda_function.b",
      change: {
        actions: ["update"],
        before: {
          environment: [{ variables: { TOKEN: "old" } }],
          memory_size: 1024,
          name: "b",
        },
        after: {
          environment: [{ variables: { TOKEN: SECRET } }],
          memory_size: 1024,
          name: "b",
        },
        after_unknown: { version: true, environment: [{ variables: {} }] },
      },
    },
    {
      address: "aws_sqs_queue.a",
      change: {
        actions: ["delete", "create"],
        before: { name: "old-q", tags: {} },
        after: { name: "new-q", tags: {} },
        after_unknown: { arn: true },
        replace_paths: [["name"]],
      },
    },
    {
      address: "aws_s3_bucket.c",
      change: {
        actions: ["create"],
        before: null,
        after: { bucket: SECRET },
        after_unknown: { arn: true },
      },
    },
    {
      address: "aws_iam_role.d",
      change: {
        actions: ["no-op"],
        before: { name: "d" },
        after: { name: "d" },
      },
    },
  ],
};

test("names what changes on each resource, in address order, and skips no-ops", () => {
  assert.deepEqual(summarize(plan), [
    "update\taws_lambda_function.b\tenvironment,version",
    "create\taws_s3_bucket.c",
    "delete+create\taws_sqs_queue.a\tarn,name\treplaced for: name",
  ]);
});

test("never prints an attribute's value", () => {
  assert.ok(!summarize(plan).join("\n").includes(SECRET));
  assert.ok(!summarize(plan).join("\n").includes("old-q"));
});

test("prints nothing for a plan with no changes", () => {
  assert.deepEqual(summarize({ resource_changes: [] }), []);
  assert.deepEqual(summarize({}), []);
});

for (const [name, address, expected] of [
  ["a for_each key", `aws_sns_topic_subscription.emails["${SECRET}@example.com"]`, "aws_sns_topic_subscription.emails[…]"],
  ["a count key", "aws_iam_role.r[2]", "aws_iam_role.r[…]"],
  ["text outside the brackets", `aws_iam_role.r["a"] ${SECRET}`, "-"],
  ["an object", { name: SECRET }, "-"],
]) {
  test(`cuts ${name} from an address, since keys can hold a value`, () => {
    const out = summarize({
      resource_changes: [{ address, change: { actions: ["create"], before: null, after: {} } }],
    });
    assert.deepEqual(out, [`create\t${expected}`]);
    assert.ok(!out.join("\n").includes(SECRET));
  });
}
