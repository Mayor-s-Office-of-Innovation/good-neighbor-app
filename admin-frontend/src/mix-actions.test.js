import assert from "node:assert/strict";
import { test } from "vitest";

import { mixActions } from "./mix-actions.js";

test("adds page actions as hidden methods", () => {
  class Host extends HTMLElement {}
  mixActions(Host, { openThing: () => "opened" });
  assert.equal(Host.prototype.openThing(), "opened");
  assert.equal(Object.keys(Host.prototype).includes("openThing"), false);
});

test("rejects a page action that would replace another page's action", () => {
  class Host extends HTMLElement {}
  assert.throws(
    () => mixActions(Host, { save() {} }, { save() {} }),
    /already has save/,
  );
});

test("rejects a page action that would hide a DOM method like focus()", () => {
  class Host extends HTMLElement {}
  assert.throws(() => mixActions(Host, { focus() {} }), /already has focus/);
  assert.equal(Host.prototype.focus, HTMLElement.prototype.focus);
});
