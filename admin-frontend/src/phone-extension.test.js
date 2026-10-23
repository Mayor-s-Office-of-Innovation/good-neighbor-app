import assert from "node:assert/strict";
import test from "node:test";
import { phoneExtensionField } from "./phone-extension.js";

test("create and empty edit fields hide extension until requested", () => {
  const html = phoneExtensionField(
    "phone",
    "extension",
    "Add extension",
    false,
    "Remove extension",
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-phone-extension hidden/);
  assert.doesNotMatch(html, /aria-expanded="false" hidden/);
});
test("existing extensions are visible without requesting them", () => {
  const html = phoneExtensionField(
    "phone",
    "extension",
    "Add extension",
    true,
    "Remove extension",
  );
  assert.match(html, /aria-expanded="true" hidden/);
  assert.doesNotMatch(html, /data-phone-extension hidden/);
});

test("removing an extension clears its value, marks the form changed, and allows adding it again", async (t) => {
  const { bindPhoneExtensions } = await import("./phone-extension.js");
  class Element {
    hidden = false;
    listeners = {};
    attributes = {};
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(key, value) { this.attributes[key] = value; }
    focus() { this.focused = true; }
  }
  const original = globalThis.HTMLElement;
  globalThis.HTMLElement = Element;
  t.after(() => { if (original) globalThis.HTMLElement = original; else delete globalThis.HTMLElement; });
  const add = new Element(), remove = new Element(), field = new Element();
  const events = [];
  const input = {value: "123", disabled: false, focus() {}, dispatchEvent(event) { events.push(event.type); }};
  field.querySelector = () => input;
  field.parentElement = {querySelector: () => add};
  add.parentElement = {querySelector: () => field};
  remove.closest = () => field;
  add.hidden = true;
  bindPhoneExtensions({querySelectorAll: selector => selector === "[data-add-extension]" ? [add] : [remove]});
  remove.listeners.click();
  assert.equal(input.value, "");
  assert.deepEqual(events, ["input", "change"]);
  assert.equal(field.hidden, true);
  assert.equal(add.hidden, false);
  assert.equal(add.focused, true);
  assert.equal(add.attributes["aria-expanded"], "false");
  add.listeners.click();
  assert.equal(field.hidden, false);
  assert.equal(add.hidden, true);
});
