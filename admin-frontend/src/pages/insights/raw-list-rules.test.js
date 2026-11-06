import { test } from "vitest";
import assert from "node:assert/strict";
import { emptyRaw } from "./insights-session.js";
import {
  exportOff,
  isListPath,
  restartsPaging,
  restores,
} from "./raw-list-rules.js";

test("a page whose cursor no longer fits starts the list again; other failures don't", () => {
  for (const code of [
    "snapshot_changed",
    "invalid_cursor",
    "cursor_query_mismatch",
  ])
    assert.equal(restartsPaging(code), true);
  assert.equal(restartsPaging("snapshot_unavailable"), false);
  assert.equal(restartsPaging(undefined), false);
});

test("only the Issues and Checks lists load as lists, not their records", () => {
  assert.equal(isListPath("/insights/raw/issues"), true);
  assert.equal(isListPath("/insights/raw/checks/"), true);
  assert.equal(isListPath("/insights/raw/issues/t1"), false);
  assert.equal(isListPath("/insights/raw"), false);
});

test("only a way back to the same list restores its rows", () => {
  const here = "/insights/raw/issues?period=2026-10";
  const memory = { ...emptyRaw(), path: here, reply: { total: 3 } };
  assert.equal(restores(memory, here, true), true);
  assert.equal(restores(memory, here, false), false);
  assert.equal(
    restores(memory, "/insights/raw/issues?period=2026-09", true),
    false,
  );
  // Nothing loaded yet, so there's nothing to show.
  assert.equal(restores({ ...memory, reply: null }, here, true), false);
});

test("Export CSV is off with nothing, an unknown count or too many rows", () => {
  assert.equal(exportOff(null), true);
  assert.equal(exportOff(0), true);
  assert.equal(exportOff(250_001), true);
  assert.equal(exportOff(250_000), false);
});
