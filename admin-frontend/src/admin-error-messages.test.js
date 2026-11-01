import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adminErrorMessage } from "./admin-error-messages.js";
import { createActionFeedback } from "./action-feedback-core.js";

const en = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => en[key] ?? key;

for (const [code, title, message] of [
  ["provider_already_exists", "providerExistsTitle", "providerExists"],
  ["site_already_exists", "siteExistsTitle", "siteExists"],
  ["provider_manager_already_assigned", "staffAssignedTitle", "staffAssigned"],
  ["provider_manager_conflict", "staffChangedTitle", "staffChanged"],
]) {
  test(`${code} has consistent toast and inline recovery instructions`, () => {
    const error = Object.assign(new Error(code), { status: 409 });
    const notices = [];
    const feedback = createActionFeedback(
      "saved",
      (notice) => notices.push(notice),
      t,
    );
    feedback.failure(error);
    feedback.failure(error);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, t(`admin.errors.${title}`));
    assert.equal(notices[0].message, t(`admin.errors.${message}`));
    assert.equal(adminErrorMessage(error, t), notices[0].message);
  });
}

test("staff validation is readable inline and does not create an extra toast", () => {
  for (const [code, key] of [
    ["provider_manager_name_required", "staffNameRequired"],
    ["valid_email_required", "emailRequired"],
    ["phone_required", "phoneRequired"],
    ["invalid_person_contact", "staffContact"],
  ]) {
    const error = Object.assign(new Error(code), { status: 400 });
    assert.equal(adminErrorMessage(error, t), t(`admin.errors.${key}`));
    const notices = [];
    createActionFeedback("saved", (notice) => notices.push(notice), t).failure(
      error,
    );
    assert.equal(notices.length, 0);
  }
});

test("unknown server errors do not leak codes or override partial-save messaging", () => {
  assert.equal(
    adminErrorMessage(
      Object.assign(new Error("database_internal_error"), { status: 500 }),
      t,
    ),
    t("admin.toast.requestFailed"),
  );
  const notices = [];
  const feedback = createActionFeedback(
    "saved",
    (notice) => notices.push(notice),
    t,
  );
  feedback.changed();
  feedback.failure(
    Object.assign(new Error("provider_manager_conflict"), { status: 409 }),
  );
  assert.equal(notices[0].title, t("admin.toast.partial"));
});

test("stale site settings explain how to recover instead of a generic failure", () => {
  const error = Object.assign(new Error("site_changed"), { status: 409 });
  assert.equal(adminErrorMessage(error, t), t("admin.errors.siteChanged"));
  assert.notEqual(adminErrorMessage(error, t), t("admin.toast.requestFailed"));
});

test("request rejections give localized recovery instructions", () => {
  for (const [code, status, key] of [
    ["request_blocked", 403, "requestBlocked"],
    ["request_too_large", 413, "requestTooLarge"],
  ]) {
    assert.equal(
      adminErrorMessage(Object.assign(new Error(code), { status }), t),
      t(`admin.errors.${key}`),
    );
  }
});

for (const locale of ["en", "es", "fil", "vi", "zh-Hant"]) {
  test(`CSV validation errors give specific recovery instructions in ${locale}`, () => {
    const catalog = JSON.parse(
      readFileSync(
        new URL(
          `../../frontend/src/i18n/catalogs/${locale}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const t = (key) => catalog[key];
    for (const [code, key] of [
      ["invalid_encoding", "invalidEncoding"],
      ["unreadable_csv", "unreadableCsv"],
      ["invalid_headers", "invalidHeaders"],
      ["invalid_row_count", "invalidRowCount"],
    ]) {
      const error = Object.assign(new Error(code), { status: 400 });
      const message = adminErrorMessage(error, t);
      assert.equal(message, t(`admin.import.${key}`));
      assert.equal(typeof message, "string");
      assert.ok(message.length > 0);
      assert.notEqual(message, t("admin.toast.requestFailed"));
      assert.notEqual(message, code);
    }
  });
}
