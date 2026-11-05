// @vitest-environment node
import { test } from "vitest";
import assert from "node:assert/strict";
import { siteSaveErrorMessage } from "./save-error-messages.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { appMessageError } from "../../admin-error-messages.js";

test("a Site save shows a sentence the page wrote, but never a server's own text", () => {
  const limit = "A site can have no more than two Program managers.";
  assert.equal(siteSaveErrorMessage(appMessageError(limit)), limit);
  const server = Object.assign(new Error("Internal server error"), {
    status: 500,
  });
  assert.equal(siteSaveErrorMessage(server), t("admin.toast.requestFailed"));
  assert.equal(
    siteSaveErrorMessage(new Error("unexpected_code")),
    t("admin.toast.requestFailed"),
  );
});
