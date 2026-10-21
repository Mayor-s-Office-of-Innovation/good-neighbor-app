import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { letterEmailProgress } from "./admin-save-state.js";

const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
const start = source.indexOf("  async refreshLetterEmails(");
const end = source.indexOf("\n  }", start) + 4;
for (const uncertain of [false, true]) {
  test(`letter completion survives navigation and is announced once (uncertain=${uncertain})`, async () => {
    const notices = [];
    const items = uncertain
      ? [{ letterJobId: "job", deliveryState: "uncertain" }]
      : [
          { letterJobId: "old", deliveryState: "uncertain" },
          {
            type: "complianceLetterEmail",
            sk: "LETTER_EMAIL#job",
            provider: "ses",
          },
        ];
    const Subject = vm.runInNewContext(
      `(class { ${source.slice(start, end)} })`,
      {
        setTimeout: (callback) => callback(),
        adminApi: { getSite: async () => ({ items }) },
        letterEmailProgress,
        t: (key) => key,
        notifyAdmin: (...args) => notices.push(args),
      },
    );
    const app = new Subject();
    app.state = { site: { siteId: "another-site" }, letterEmailHistory: [] };
    app.render = () => assert.fail("Do not rerender another site");
    await app.refreshLetterEmails("original-site", "job");
    await app.refreshLetterEmails("original-site", "job");
    assert.equal(notices.length, 1);
    assert.equal(
      notices[0][0],
      uncertain ? "admin.toast.deliveryUncertain" : "admin.letters.sent",
    );
    assert.deepEqual(app.state.letterEmailHistory, []);
  });
}
