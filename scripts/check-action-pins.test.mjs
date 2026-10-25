import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkActionPins, checkWorkflowPins } from "./check-action-pins.mjs";

const sha = "a".repeat(40);
const stepWorkflow = (reference) =>
  `jobs: {test: {steps: [{uses: ${JSON.stringify(reference)}}]}}`;

test("allows full SHAs, action subpaths, local references, and image digests", () => {
  for (const reference of [
    `actions/checkout@${sha}`,
    `github/codeql-action/init@${sha}`,
    "./.github/actions/local",
    `docker://alpine@sha256:${"b".repeat(64)}`,
  ]) {
    assert.deepEqual(checkWorkflowPins(stepWorkflow(reference)), []);
  }
  assert.deepEqual(
    checkWorkflowPins("jobs: {deploy: {uses: ./.github/workflows/deploy.yml}}"),
    [],
  );
  assert.deepEqual(
    checkWorkflowPins(
      `jobs: {deploy: {uses: org/repo/.github/workflows/deploy.yml@${sha}}}`,
    ),
    [],
  );
});

test("rejects tags, branches, short hashes, expressions, and unpinned images", () => {
  for (const reference of [
    "actions/checkout@v7",
    "actions/checkout@v7.0.1",
    "actions/checkout@main",
    "actions/checkout@abcdef1",
    "${{ inputs.action }}",
    "docker://alpine:3",
    "docker://alpine",
    null,
  ]) {
    assert.equal(checkWorkflowPins(stepWorkflow(reference)).length, 1);
  }
  assert.equal(
    checkWorkflowPins(
      "jobs: {deploy: {uses: org/repo/.github/workflows/deploy.yml@main}}",
    ).length,
    1,
  );
});

test("handles quoted keys, flow mappings, aliases, and folded values", () => {
  const errors = checkWorkflowPins(`
jobs:
  test:
    steps:
      - &checkout {"uses": "actions/checkout@v7"}
      - *checkout
      - uses: >-
          actions/setup-node@v7
      - run: |
          echo 'uses: actions/checkout@main'
`);
  assert.equal(errors.length, 3);
  assert.match(errors[2], /steps\[2\]/);
});

test("fails closed on malformed YAML or missing jobs", () => {
  assert.throws(() => checkWorkflowPins("jobs: ["));
  assert.throws(() => checkWorkflowPins("name: empty"));
  assert.throws(() =>
    checkWorkflowPins("jobs: {test: {uses: x/y@v1, uses: x/y@v2}}"),
  );
});

test("scans both workflow extensions and ignores unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "action-pins-"));
  try {
    const workflows = join(root, ".github/workflows");
    await mkdir(workflows, { recursive: true });
    await assert.rejects(checkActionPins(root), /No workflow files/);
    await writeFile(
      join(workflows, "ci.yml"),
      stepWorkflow(`org/action@${sha}`),
    );
    await writeFile(
      join(workflows, "deploy.yaml"),
      stepWorkflow("org/action@v1"),
    );
    await writeFile(join(workflows, "README.md"), "Not YAML");
    const errors = await checkActionPins(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /deploy\.yaml/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
