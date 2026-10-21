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
    await app[`create${kind}`]({});
    assert.equal(mutations, 1);
    assert.equal(app.state[`${kind.toLowerCase()}s`][0].name, "New");
    assert.deepEqual(destinations, [`/${kind.toLowerCase()}s/new`]);
  });
}
