import assert from "node:assert/strict";
import { test } from "node:test";
import { e2ePort } from "./ports.mjs";

test("automatic picks skip pinned ports and duplicate pins fail", async () => {
  process.env.E2E_PORT_TEST_PIN = "3101";
  try {
    assert.equal(await e2ePort("E2E_PORT_TEST_PIN", 3001), 3101);
    assert.notEqual(await e2ePort("E2E_PORT_TEST_AUTO", 3101), 3101);
    process.env.E2E_PORT_TEST_DUPLICATE = "3101";
    await assert.rejects(
      e2ePort("E2E_PORT_TEST_DUPLICATE", 3001),
      /both select port/,
    );
    assert.equal(await e2ePort("E2E_PORT_TEST_PIN", 3001), 3101);
    process.env.E2E_PORT_TEST_INVALID = "not-a-port";
    await assert.rejects(
      e2ePort("E2E_PORT_TEST_INVALID", 3001),
      /invalid port/,
    );
  } finally {
    for (const name of ["PIN", "AUTO", "DUPLICATE", "INVALID"])
      delete process.env[`E2E_PORT_TEST_${name}`];
  }
});
