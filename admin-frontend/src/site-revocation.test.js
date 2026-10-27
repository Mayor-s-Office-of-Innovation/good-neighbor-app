import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
function fixture(editable = true) {
  const listeners = {};
  const input = {
    value: "",
    disabled: false,
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    },
  };
  const button = { disabled: true };
  const form = {
    querySelector: (selector) => (selector === "button" ? button : input),
    addEventListener: (event, handler) => {
      listeners[event] = handler;
    },
  };
  const app = {
    state: { site: { name: "Site One" }, siteCanEdit: editable },
    querySelector: () => form,
    render() {},
  };
  const start = source.indexOf(
    '    const revokeAllForm = this.querySelector("#revoke-all-site-devices");',
  );
  const end = source.indexOf("    const revokeManagerForm =", start);
  vm.runInNewContext(`(function() {${source.slice(start, end)}})`, {
    canEditSite: (state) => state.siteCanEdit,
  }).call(app);
  return { app, input, button, listeners, form };
}
const submitEvent = { preventDefault() {} };
test("site revocation requires exact confirmation and edit permission", async () => {
  for (const editable of [true, false]) {
    const f = fixture(editable);
    let calls = 0;
    f.app.revokeAllSiteDevices = async () => {
      calls++;
    };
    assert.equal(f.button.disabled, true);
    f.input.value = "site one";
    f.listeners.input();
    await f.listeners.submit(submitEvent);
    assert.equal(calls, 0);
    f.input.value = "Site One";
    f.listeners.input();
    assert.equal(f.button.disabled, !editable);
    await f.listeners.submit(submitEvent);
    assert.equal(calls, editable ? 1 : 0);
  }
});
test("site revocation suppresses repeat submissions and restores controls after failure", async () => {
  const f = fixture();
  let reject;
  let calls = 0;
  f.app.revokeAllSiteDevices = () => {
    calls++;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  };
  f.input.value = "Site One";
  const pending = f.listeners.submit(submitEvent);
  assert.equal(f.button.disabled, true);
  assert.equal(f.input.disabled, true);
  f.listeners.input();
  await f.listeners.submit(submitEvent);
  assert.equal(calls, 1);
  reject(new Error("revocation failed"));
  await pending;
  assert.equal(f.app.state.error, "revocation failed");
  assert.equal(f.input.disabled, false);
  assert.equal(f.button.disabled, false);
  f.app.state.siteCanEdit = false;
  await f.listeners.submit(submitEvent);
  assert.equal(calls, 1);
});
test("site revocation sends the site ID and confirmation to the API", async () => {
  const calls = [];
  const start = source.indexOf("  async revokeAllSiteDevices(form)");
  const end = source.indexOf("  async beginPhysicalDeviceRevocation", start);
  const actions = vm.runInNewContext(`({${source.slice(start, end)}})`, {
    FormData: class {
      constructor(form) {
        this.form = form;
      }
    },
    formValue: (data) => data.form.confirmation,
    actionFeedback: () => ({ success() {}, failure() {} }),
    adminApi: {
      revokeAllSiteDeviceBindings: async (...args) => {
        calls.push(args);
        return { status: "complete", affectedCount: 1 };
      },
    },
  });
  await actions.revokeAllSiteDevices.call(
    {
      state: { site: { siteId: "s" } },
      async refreshSiteAccess() {},
      render() {},
    },
    { confirmation: "Site One" },
  );
  assert.deepEqual(calls, [["s", "Site One"]]);
});
