import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { createActionFeedback } from "./action-feedback-core.js";
const en = JSON.parse(
  readFileSync(
    new URL("../../frontend/src/i18n/catalogs/en.json", import.meta.url),
    "utf8",
  ),
);
const t = (key) => en[key] ?? key;

test("duplicate programs explain the conflict and recovery in one toast", () => {
  const notices = [];
  const feedback = createActionFeedback(
    "admin.toast.programCreated",
    (notice) => notices.push(notice),
    t,
  );
  const error = Object.assign(new Error("program_already_exists"), {
    status: 409,
  });
  feedback.failure(error);
  feedback.failure(error);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, t("admin.programs.duplicateTitle"));
  assert.equal(notices[0].message, t("admin.programs.duplicateHelp"));
  assert.equal(notices[0].tone, "error");
});

function setup() {
  const notices = [];
  const notify = (options) => {
    const item = {
      ...options,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    notices.push(item);
    return item;
  };
  return {
    notices,
    feedback: createActionFeedback("saved", notify, (key) => key),
    notify,
  };
}

test("confirmed save followed by refresh failure replaces success with saved warning", () => {
  const { feedback, notices } = setup();
  feedback.success();
  feedback.failure(new Error("offline"));
  assert.equal(notices[0].closed, true);
  assert.equal(notices[1].title, "admin.toast.refreshFailed");
  assert.equal(notices[1].tone, "info");
  assert.equal(notices[1].message, "admin.toast.refreshHelp");
});

test("partial multi-step mutation is not described as a complete failure", () => {
  const { feedback, notices } = setup();
  feedback.changed();
  feedback.failure(Object.assign(new Error("conflict"), { status: 409 }));
  assert.equal(notices[0].title, "admin.toast.partial");
});

test("validation remains inline and server failures receive one error toast", () => {
  for (const status of [400, 422]) {
    const { feedback, notices } = setup();
    feedback.failure(Object.assign(new Error("validation"), { status }));
    assert.equal(notices.length, 0);
  }
  const { feedback, notices, notify } = setup();
  const error = Object.assign(new Error("server down"), { status: 503 });
  feedback.failure(error);
  feedback.failure(error);
  createActionFeedback("other", notify, (key) => key).failure(error);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].tone, "error");
});

test("informational and failed outcomes use matching icons and longer duration", () => {
  for (const [tone, icon] of [
    ["info", "circle-info"],
    ["error", "circle-xmark"],
  ]) {
    const { feedback, notices } = setup();
    feedback.success("outcome", tone);
    assert.equal(notices[0].icon, icon);
    assert.equal(notices[0].duration, 8000);
  }
});

test("unconfirmed delivery still records a completed server operation", () => {
  const { feedback, notices } = setup();
  feedback.success("delivery-unconfirmed", "error");
  feedback.failure(new Error("refresh failed"));
  assert.equal(notices[1].title, "admin.toast.refreshFailed");
});
test("permission, server and conflict errors are not field validation", () => {
  for (const [status, message] of [
    [403, "supervisor_required"],
    [500, "invalid_state"],
    [409, "conflict"],
  ]) {
    const { feedback, notices } = setup();
    feedback.failure(Object.assign(new Error(message), { status }));
    assert.equal(notices.length, 1);
  }
});
