import { test } from "vitest";
import assert from "node:assert/strict";
import { insightsAvailable, modeMemory } from "./mode-memory.js";

test("Insights shows only when switched on and the session allows it", () => {
  const allowed = { viewInsights: true };
  assert.equal(insightsAvailable({ insightsEnabled: true }, allowed), true);
  assert.equal(insightsAvailable({}, allowed), false);
  assert.equal(insightsAvailable({ insightsEnabled: "true" }, allowed), false);
  assert.equal(insightsAvailable({ insightsEnabled: true }, {}), false);
  assert.equal(
    insightsAvailable({ insightsEnabled: true }, { viewInsights: "yes" }),
    false,
  );
});

test("each mode tab starts at its home page", () => {
  const memory = modeMemory();
  assert.equal(memory.href("manage"), "/sites");
  assert.equal(memory.href("insights"), "/insights");
});

test("leaving a page remembers it for its mode tab", () => {
  const memory = modeMemory();
  memory.leave("/sites/s1?section=oversight", 120, "site-name");
  memory.leave("/insights/trends?period=2026-09", 40, "");
  assert.equal(memory.href("manage"), "/sites/s1?section=oversight");
  assert.equal(memory.href("insights"), "/insights/trends?period=2026-09");
  assert.deepEqual(memory.arrive("/sites/s1?section=oversight"), {
    scrollY: 120,
    focus: "site-name",
  });
});

test("arriving somewhere else restores nothing", () => {
  const memory = modeMemory();
  memory.leave("/insights/trends", 40, "");
  memory.leave("/sites/s1", 40, "");
  assert.equal(memory.arrive("/insights"), null);
  assert.equal(memory.arrive("/sites"), null);
});

test("Settings, creation pages and unsafe paths are never remembered", () => {
  const memory = modeMemory();
  memory.leave("/sites/s1", 10, "");
  memory.leave("/insights/trends", 10, "");
  for (const path of [
    "/system-status",
    "/profile",
    "/sites/new",
    "/sites/import",
    "/insights/raw",
    "/insights/compliance",
    "//example.org/sites",
    "/not-a-page",
  ])
    memory.leave(path, 10, "");
  assert.equal(memory.href("manage"), "/sites/s1");
  assert.equal(memory.href("insights"), "/insights/trends");
});

test("a remembered Insights page drops a nested return link", () => {
  const memory = modeMemory();
  memory.leave("/insights?return=%2Fsites&period=2026-09", 0, "");
  assert.equal(memory.href("insights"), "/insights?period=2026-09");
});

test("a remembered Manage page drops its old way back to Insights", () => {
  const memory = modeMemory();
  memory.leave(
    "/sites/s1?return=%2Finsights%2Ftrends&section=oversight",
    30,
    "",
  );
  assert.equal(memory.href("manage"), "/sites/s1?section=oversight");
  assert.deepEqual(memory.arrive("/sites/s1?section=oversight"), {
    scrollY: 30,
    focus: "",
  });
});

test("a page is found again however its query was written", () => {
  const memory = modeMemory();
  memory.leave("/insights/trends?from=2026-09-01T00:00", 40, "");
  const place = { scrollY: 40, focus: "" };
  // As Back returns it, and as the tab reopens it after re-encoding.
  for (const path of [
    "/insights/trends?from=2026-09-01T00:00",
    "/insights/trends?from=2026-09-01T00%3A00",
  ])
    assert.deepEqual(memory.arrive(path), place, path);
});

test("leaving a page too unsafe to keep forgets the older one", () => {
  const memory = modeMemory();
  memory.leave("/insights/sites/s1", 10, "");
  memory.leave(`/insights?q=${"a".repeat(5000)}`, 10, "");
  assert.equal(memory.href("insights"), "/insights");
});

test("a page that only redirects keeps the last real page", () => {
  const memory = modeMemory();
  memory.leave("/insights/sites/s1", 10, "");
  memory.leave("/insights/raw", 0, "");
  memory.leave("/insights/compliance", 0, "");
  assert.equal(memory.href("insights"), "/insights/sites/s1");
});

test("a Manage page matches itself with or without a return", () => {
  const memory = modeMemory();
  memory.leave("/sites?q=a%20b&return=%2Finsights", 30, "");
  assert.deepEqual(memory.arrive("/sites?q=a%20b"), { scrollY: 30, focus: "" });
});

test("an unencoded ? inside a Manage query keeps the rest of the query", () => {
  const memory = modeMemory();
  memory.leave("/sites/s1?return=/insights?period=7d&section=staff", 0, "");
  assert.equal(memory.href("manage"), "/sites/s1?section=staff");
});
