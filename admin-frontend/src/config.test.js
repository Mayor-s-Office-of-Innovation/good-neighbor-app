import { afterEach, test } from "vitest";
import assert from "node:assert/strict";
import { getAdminConfig } from "./config.js";

const scope = /** @type {Record<string, unknown>} */ (
  /** @type {unknown} */ (globalThis)
);
const saved = { window: scope.window, location: scope.location };

/** @param {Record<string, unknown>} config */
function withConfig(config) {
  scope.window = { GOOD_NEIGHBOR_ADMIN_CONFIG: config };
  scope.location = { origin: "https://admin.example.org", pathname: "/" };
  return getAdminConfig();
}

// REVIEW.md asks tests to undo changes to globals.
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete scope[key];
    else scope[key] = value;
  }
});

test("Insights is off unless config.js says a literal true", () => {
  assert.equal(withConfig({}).insightsEnabled, false);
  assert.equal(withConfig({ insightsEnabled: "false" }).insightsEnabled, false);
  assert.equal(withConfig({ insightsEnabled: "true" }).insightsEnabled, false);
  assert.equal(withConfig({ insightsEnabled: true }).insightsEnabled, true);
});
