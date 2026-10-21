import test from "node:test";
import assert from "node:assert/strict";
import { upsertRecord, withSaveFeedback } from "./save-feedback.js";

test("confirmed records update the cache without losing unrelated data", () => {
  const original = [
    { id: "one", name: "Old", detail: "keep" },
    { id: "two", name: "Other" },
  ];
  assert.deepEqual(upsertRecord(original, { id: "one", name: "New" }, "id"), [
    { id: "one", name: "New", detail: "keep" },
    original[1],
  ]);
  assert.equal(upsertRecord(original, { id: "three" }, "id").length, 3);
  assert.equal(original[0].name, "Old");
});

test("pending saves reject duplicate submissions and failures preserve the draft", async () => {
  const oldDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, remove() {} }),
  };
  try {
    const button = { textContent: "Save", disabled: false };
    const form = {
      dataset: {},
      draft: "unsaved name",
      setAttribute() {},
      removeAttribute() {},
      querySelectorAll: () => [button],
      querySelector: () => null,
      append() {},
      dispatchEvent() {},
    };
    let reject;
    let calls = 0;
    let message;
    const options = {
      savingLabel: "Saving…",
      onError: (error) => {
        message = error.message;
      },
    };
    const pending = withSaveFeedback(
      form,
      () => {
        calls++;
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
      options,
    );
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Saving…");
    assert.equal(
      await withSaveFeedback(
        form,
        () => {
          calls++;
        },
        options,
      ),
      false,
    );
    assert.equal(calls, 1);
    reject(new Error("offline"));
    assert.equal(await pending, false);
    assert.equal(message, "offline");
    assert.equal(form.draft, "unsaved name");
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Save");
    assert.equal(await withSaveFeedback(form, async () => true, options), true);
  } finally {
    globalThis.document = oldDocument;
  }
});

test("save completion lets form validation override the old enabled state", async () => {
  const oldDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, remove() {} }),
  };
  try {
    const button = { textContent: "Save", disabled: false };
    const form = new EventTarget();
    Object.assign(form, {
      dataset: {},
      setAttribute() {},
      removeAttribute() {},
      querySelectorAll: () => [button],
      querySelector: () => null,
      append() {},
    });
    let selectedStaff = "person";
    form.addEventListener("save-feedback-end", () => {
      assert.equal(form.dataset.saving, undefined);
      button.disabled = !selectedStaff;
    });
    await withSaveFeedback(
      form,
      async () => {
        selectedStaff = "";
        throw new Error("source changed");
      },
      { savingLabel: "Saving", onError() {} },
    );
    assert.equal(button.disabled, true);
  } finally {
    globalThis.document = oldDocument;
  }
});
