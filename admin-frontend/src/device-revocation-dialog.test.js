import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(
  new URL("./device-revocation-dialog.js", import.meta.url),
  "utf8",
);

for (const value of ["confirm", "cancel", ""]) {
  test(`device removal requires explicit confirmation (${value || "Escape"})`, async () => {
    let close;
    let shown = false;
    let removed = false;
    class Trigger {
      isConnected = true;
      focused = false;
      focus() {
        this.focused = true;
      }
    }
    const trigger = new Trigger();
    const dialog = {
      returnValue: value,
      setAttribute() {},
      addEventListener(event, callback) {
        if (event === "close") close = callback;
      },
      removeEventListener() {},
      showModal() {
        shown = true;
      },
      remove() {
        removed = true;
      },
    };
    const confirm = vm.runInNewContext(
      source
        .replace(/^import .*;\n/gm, "")
        .replace("export function", "function") + "\nconfirmDeviceRevocation;",
      {
        t: (key) => key,
        escapeHtml: (value) => value,
        HTMLElement: Trigger,
        document: {
          activeElement: trigger,
          createElement: () => dialog,
          body: { append() {} },
        },
      },
    );
    let settled = false;
    const pending = confirm("Synthetic device", "Synthetic site").then(
      (result) => {
        settled = true;
        return result;
      },
    );
    assert.equal(shown, true);
    assert.equal(settled, false);
    close();
    assert.equal(await pending, value === "confirm");
    assert.equal(removed, true);
    assert.equal(trigger.focused, true);
  });
}

test("navigation abort removes the confirmation without restoring stale focus", async () => {
  const listeners = new Map();
  let removed = false;
  let focused = false;
  class Trigger {
    isConnected = true;
    focus() {
      focused = true;
    }
  }
  const dialog = {
    returnValue: "",
    setAttribute() {},
    showModal() {},
    addEventListener: (event, handler) => listeners.set(event, handler),
    removeEventListener: (event) => listeners.delete(event),
    close(value) {
      this.returnValue = value;
      listeners.get("close")?.();
    },
    remove() {
      removed = true;
    },
  };
  const confirm = vm.runInNewContext(
    source
      .replace(/^import .*;\n/gm, "")
      .replace("export function", "function") + "\nconfirmDeviceRevocation;",
    {
      t: (key) => key,
      escapeHtml: (value) => value,
      HTMLElement: Trigger,
      document: {
        activeElement: new Trigger(),
        createElement: () => dialog,
        body: { append() {} },
      },
    },
  );
  const controller = new AbortController();
  const pending = confirm("Synthetic device", "Synthetic site", {
    signal: controller.signal,
  });
  controller.abort();
  assert.equal(await pending, false);
  assert.equal(removed, true);
  assert.equal(focused, false);
  removed = false;
  assert.equal(
    await confirm("Synthetic device", "Synthetic site", {
      signal: controller.signal,
    }),
    false,
  );
  assert.equal(removed, false);
});
