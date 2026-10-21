import assert from "node:assert/strict";
import test from "node:test";
import { phoneExtensionField } from "./phone-extension.js";

test("create and empty edit fields hide extension until requested", () => {
  const html = phoneExtensionField(
    "phone",
    "extension",
    "Add extension",
    false,
  );
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-phone-extension hidden/);
  assert.doesNotMatch(html, /aria-expanded="false" hidden/);
});
test("existing extensions are visible without requesting them", () => {
  const html = phoneExtensionField("phone", "extension", "Add extension", true);
  assert.match(html, /aria-expanded="true" hidden/);
  assert.doesNotMatch(html, /data-phone-extension hidden/);
});
