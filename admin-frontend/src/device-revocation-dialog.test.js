import { afterEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { t } from "../../frontend/src/i18n/i18n.js";
import { quietInspect } from "../test-support/quiet-inspect.js";
import { confirmDeviceRevocation } from "./device-revocation-dialog.js";

quietInspect(window);

const dialog = () =>
  document.querySelector('dialog[aria-labelledby="device-revocation-title"]');

/** A click focuses its button first, as a browser does. @param {string} value */
function choose(value) {
  const button = dialog().querySelector(`button[value="${value}"]`);
  button.focus();
  button.click();
}

/** A focused button, as the remove button is when a user clicks it. */
function focusedTrigger() {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  return trigger;
}

afterEach(() => {
  document.body.replaceChildren();
});

for (const [answer, close] of [
  ["confirm", () => choose("confirm")],
  ["cancel", () => choose("cancel")],
  // happy-dom has no Escape handling; a browser closes the dialog with no value.
  ["Escape", () => dialog().close()],
])
  test(`device removal resolves only on an explicit Remove (${answer})`, async () => {
    const trigger = focusedTrigger();
    let settled = false;
    const pending = confirmDeviceRevocation(
      "<b>Synthetic phone</b>",
      "Synthetic Site",
    ).then((result) => {
      settled = true;
      return result;
    });
    assert.equal(dialog().open, true);
    assert.equal(
      dialog().querySelector("#device-revocation-title").textContent,
      t("admin.devices.revokeTitle"),
    );
    // A device label is user-entered, so it must show as text, not markup.
    assert.ok(!dialog().querySelector("b"));
    assert.equal(
      dialog().querySelector("#device-revocation-copy").textContent,
      t("admin.devices.revokeDescription", {
        name: "<b>Synthetic phone</b>",
        site: "Synthetic Site",
      }),
    );
    await Promise.resolve();
    assert.equal(settled, false);
    if (answer === "Escape") dialog().querySelector("button").focus();
    close();
    assert.equal(await pending, answer === "confirm");
    assert.ok(!dialog());
    assert.ok(document.activeElement === trigger);
  });

test("a trigger removed while the dialog was open does not take focus back", async () => {
  const trigger = focusedTrigger();
  const pending = confirmDeviceRevocation("Synthetic phone", "Synthetic Site");
  trigger.remove();
  // happy-dom ignores focus() on a detached node, so watch the call itself.
  const focus = vi.spyOn(trigger, "focus");
  choose("cancel");
  assert.equal(await pending, false);
  assert.equal(focus.mock.calls.length, 0);
});

test("navigation abort removes the dialog without restoring stale focus", async () => {
  const trigger = focusedTrigger();
  const controller = new AbortController();
  const pending = confirmDeviceRevocation("Synthetic phone", "Synthetic Site", {
    signal: controller.signal,
  });
  dialog().querySelector('button[value="confirm"]').focus();
  controller.abort();
  assert.equal(await pending, false);
  assert.ok(!dialog());
  assert.ok(document.activeElement !== trigger);
});

test("an already aborted signal never opens the dialog", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await confirmDeviceRevocation("Synthetic phone", "Synthetic Site", {
      signal: controller.signal,
    }),
    false,
  );
  assert.ok(!dialog());
});
