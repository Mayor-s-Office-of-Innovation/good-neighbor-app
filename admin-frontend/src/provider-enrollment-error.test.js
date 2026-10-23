import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { escapeHtml } from "./dom.js";

test("pending invitation error is rendered only inside the implicated manager row", () => {
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const start = source.indexOf("function providerAccessView(state) {");
  const end = source.indexOf("\n}", start) + 2;
  const context = vm.createContext({
    escapeHtml,
    t: (key) => key,
    providerEmailActions: () => "",
    providerManagerGrantList: () => "",
    providerManagerEnrollmentList: () => "",
    providerDeviceRemovalForm: () => "",
  });
  vm.runInContext(source.slice(start, end), context);
  const state = {
    providerManagers: ["a", "b"].map((membershipId) => ({
      membershipId,
      name: membershipId,
      email: `${membershipId}@example.org`,
      status: "active",
    })),
    providerManagerGrantErrors: { b: "Cancel the pending invitation <first>" },
  };
  const html = context.providerAccessView(state);
  const rows = html.match(/<li>.*?<\/li>/g);
  assert.doesNotMatch(rows[0], /role="alert"/);
  assert.match(rows[1], /role="alert" data-provider-manager-grant-error="b"/);
  assert.match(rows[1], /Cancel the pending invitation &lt;first&gt;/);
  state.providerManagerGrantErrors = {};
  assert.doesNotMatch(context.providerAccessView(state), /role="alert"/);
});
