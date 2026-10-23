import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const method = source.slice(source.indexOf("  updateComplianceManagerCount() {"), source.indexOf("  async createOversightOption("));
test("counts manager rows without counting their nested action buttons and updates limit message", () => {
  const app = vm.runInNewContext(`({${method}})`);
  const button = {}, limit = {}, empty = {};
  app.querySelector = selector => selector === "#add-compliance-manager" ? button : selector === "[data-compliance-manager-limit]" ? limit : empty;
  for (const count of [1, 2, 1, 0]) {
    app.querySelectorAll = selector => {
      assert.equal(selector, "[data-compliance-manager-list] > li[data-manager-id]");
      return Array(count).fill({});
    };
    app.updateComplianceManagerCount();
    assert.equal(button.disabled, count >= 2);
    assert.equal(limit.hidden, count < 2);
    assert.equal(empty.hidden, count > 0);
  }
});
