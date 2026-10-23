import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { loadProviderStaff } from "./provider-staff.js";
const source = readFileSync(
  new URL("./new-program-staff.js", import.meta.url),
  "utf8",
);

class Element extends EventTarget {
  dataset = {};
  value = "";
  children = [];
  isConnected = true;
  disabled = false;
  hidden = false;
  textContent = "";
  append(child) {
    this.children.push(child);
  }
  replaceChildren() {
    this.children = [];
  }
  insertBefore(child, before) {
    this.children.splice(this.children.indexOf(before), 0, child);
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  querySelector() {
    return this.children.find((child) => child.dataset.staffDraft);
  }
  focus() {}
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("failed staff lookup preserves creation and retry preserves a draft", async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => new Element() };
  try {
    const form = new Element();
    const provider = new Element();
    provider.value = "provider";
    const select = new Element();
    const save = new Element();
    const error = new Element();
    const retry = new Element();
    const dialog = new Element();
    const draftForm = new Element();
    draftForm.reset = () => {};
    const cancel = new Element();
    form.querySelector = (selector) =>
      ({
        '[name="program-provider"]': provider,
        '[name="program-staff"]': select,
        '[type="submit"]': save,
        "[data-staff-error]": error,
        "[data-retry-staff]": retry,
      })[selector];
    dialog.querySelector = (selector) =>
      selector === "form" ? draftForm : cancel;
    let opened = 0;
    dialog.showModal = () => {
      opened++;
    };
    let calls = 0;
    const api = {
      listProviderManagers: async () => {
        if (++calls === 1) throw new Error("offline");
        return {
          managers: [
            {
              membershipId: "existing",
              status: "active",
              firstName: "Existing",
              lastName: "Person",
              email: "person@example.org",
            },
          ],
        };
      },
    };
    const bindNewProgramStaff = vm.runInNewContext(
      source
        .replace(/^import .*;$/gm, "")
        .replace("export function", "function") + "\nbindNewProgramStaff",
      { document: globalThis.document, t: (key) => key, loadProviderStaff },
    );
    bindNewProgramStaff(
      {
        querySelector: (selector) =>
          selector === "#program-form" ? form : dialog,
      },
      [],
      api,
    );
    await settle();
    assert.equal(select.disabled, false);
    assert.equal(select.lastElementChild.value, "__create__");
    assert.equal(retry.hidden, false);
    assert.ok(error.textContent);
    select.value = "__create__";
    select.dispatchEvent(new Event("change"));
    assert.equal(opened, 1);
    const draft = new Element();
    draft.dataset.staffDraft = "true";
    draft.value = "draft-payload";
    select.insertBefore(draft, select.lastElementChild);
    select.value = draft.value;
    retry.dispatchEvent(new Event("click"));
    await settle();
    assert.equal(calls, 2);
    assert.equal(select.value, "draft-payload");
    assert.equal(select.children.includes(draft), true);
    assert.equal(select.children.length, 3);
    assert.equal(select.lastElementChild.value, "__create__");
    assert.equal(save.disabled, false);
    assert.equal(retry.hidden, true);
  } finally {
    globalThis.document = previousDocument;
  }
});
