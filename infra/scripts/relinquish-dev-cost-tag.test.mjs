import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./relinquish-dev-cost-tag.sh", import.meta.url),
);
const address = "module.app.aws_ce_cost_allocation_tag.application";

function run({
  environment = "dev",
  entries = "",
  listStatus = 0,
  removeStatus = 0,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gn-cost-tag-test-"));
  try {
    const log = join(directory, "calls");
    writeFileSync(log, "");
    writeFileSync(
      join(directory, "terraform"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TF_TEST_LOG"
if [ "$*" = "state list" ]; then
  printf '%s\\n' "$TF_TEST_ENTRIES"
  exit "$TF_TEST_LIST_STATUS"
fi
exit "$TF_TEST_REMOVE_STATUS"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        DEPLOY_ENVIRONMENT: environment,
        TF_TEST_LOG: log,
        TF_TEST_ENTRIES: entries,
        TF_TEST_LIST_STATUS: String(listStatus),
        TF_TEST_REMOVE_STATUS: String(removeStatus),
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

for (const entry of [address, `${address}[0]`]) {
  test(`forgets only the cost tag using a backend lock: ${entry}`, () => {
    assert.deepEqual(
      run({
        entries: `module.app.aws_budgets_budget.daily_application_cost\n${entry}`,
      }),
      {
        status: 0,
        calls: ["state list", `state rm -lock-timeout=5m ${address}`],
      },
    );
  });
}

test("is idempotent and ignores similarly named resources", () => {
  assert.deepEqual(
    run({
      entries: `${address}_other\nmodule.app.aws_budgets_budget.daily_application_cost`,
    }),
    {
      status: 0,
      calls: ["state list"],
    },
  );
});

for (const environment of ["prod", "", "development"]) {
  test(`refuses ${JSON.stringify(environment)} before accessing state`, () => {
    const result = run({ environment, entries: address });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  });
}

test("stops when state listing fails", () => {
  assert.deepEqual(run({ listStatus: 7, entries: address }), {
    status: 7,
    calls: ["state list"],
  });
});

test("propagates removal failure to stop deployment", () => {
  assert.deepEqual(run({ removeStatus: 8, entries: address }), {
    status: 8,
    calls: ["state list", `state rm -lock-timeout=5m ${address}`],
  });
});
