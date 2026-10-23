import { createActionFeedback } from "./action-feedback-core.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { upsertRecord } from "./save-feedback.js";

for (const kind of ["Provider", "Program"]) {
  test(`${kind} creation uses its confirmed response without a directory reload`, async () => {
    const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const start = source.indexOf(`  async create${kind}(form)`);
    const end = source.indexOf("\n  }", start) + 4;
    const destinations = [];
    let mutations = 0;
    const record =
      kind === "Provider"
        ? { providerId: "new", name: "New" }
        : { programId: "new", providerId: "provider", name: "New" };
    const context = vm.createContext({
      upsertRecord,
      URLSearchParams,
      location: { pathname: `/${kind.toLowerCase()}s/new`, search: "" },
      window: { location: { search: "" } },
      FormData: class {
        get(name) {
          return name === "program-staff"
            ? encodeURIComponent(
                JSON.stringify({
                  firstStaff: {
                    firstName: "Test",
                    lastName: "Person",
                    email: "test@example.org",
                  },
                }),
              )
            : "New";
        }
      },
      actionFeedback: (key) =>
        createActionFeedback(
          key,
          () => ({ close() {} }),
          (key) => key,
        ),
      adminApi: {
        [`create${kind}`]: async () => {
          mutations++;
          return { [kind.toLowerCase()]: record };
        },
      },
      navigate: (path) => destinations.push(path),
    });
    const Subject = vm.runInContext(
      `(class{${source.slice(start, end)} async loadDirectory(){throw new Error('Unexpected global reload');}})`,
      context,
    );
    const app = new Subject();
    app.state = { providers: [], programs: [] };
    await app[`create${kind}`]({ querySelector: () => ({ disabled: false }) });
    assert.equal(mutations, 1);
    assert.equal(app.state[`${kind.toLowerCase()}s`][0].name, "New");
    assert.deepEqual(destinations, [`/${kind.toLowerCase()}s/new`]);
  });
}

for (const [staff, disabled] of [
  ["", false],
  ["__create__", false],
  [encodeURIComponent("{}"), false],
  [encodeURIComponent('{"existingStaff":{"userId":"one"}}'), true],
]) {
  test(`program creation rejects missing or loading staff (${staff}, ${disabled})`, async () => {
    const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
    const start = source.indexOf("  async createProgram(form)");
    const end = source.indexOf("\n  }", start) + 4;
    let calls = 0;
    const Subject = vm.runInNewContext(`(class{${source.slice(start, end)}})`, {
      location: { pathname: "/programs/new", search: "" },
      window: { location: { search: "" } },
      URLSearchParams,
      FormData: class {
        get(key) {
          return key === "program-staff" ? staff : "New";
        }
      },
      t: (key) => key,
      actionFeedback: (key) =>
        createActionFeedback(
          key,
          () => ({ close() {} }),
          (key) => key,
        ),
      adminApi: {
        createProgram: () => {
          calls++;
        },
      },
    });
    await assert.rejects(
      new Subject().createProgram({ querySelector: () => ({ disabled }) }),
      /admin.programs.chooseStaff/,
    );
    assert.equal(calls, 0);
  });
}
