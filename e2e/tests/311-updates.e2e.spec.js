// @ts-check
import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";
import { PHOTO_ISSUES } from "../helpers/fixtures.js";

/** Stateful API boundary fixture: browser reloads must fetch the saved events. */
async function filedTicket(
  /** @type {import('@playwright/test').Page} */ page,
) {
  const task = {
    taskId: "311-update-fixture",
    checkId: "311-update-check",
    kind: "action",
    category: "Litter",
    status: "in_progress",
    completedAt: "",
    userFriendlyLabel: "311 update fixture",
    createdAt: "2026-09-01T12:00:00Z",
    inProgressAt: "2026-09-01T12:01:00Z",
    appActionResults: [
      {
        code: "create_311_ticket",
        payload: { tickets: [{ srNum: "123456" }] },
      },
    ],
  };
  /** @type {Array<Record<string, any>>} */
  const updates = [];
  /** @type {Array<{body: Record<string, any>, key: string | undefined}>} */
  const requests = [];
  const state = { failDelivery: false, uploads: 0, task, updates, requests };
  await page.route("**/v1/tasks?*", (route) =>
    route.fulfill({ json: { tasks: [task] } }),
  );
  await page.route("**/v1/checks?*", (route) =>
    route.fulfill({ json: { checks: [] } }),
  );
  await page.route("**/v1/tasks/311-update-fixture/updates*", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      const key = request.headers()["idempotency-key"];
      requests.push({ body, key });
      if (!updates.some((update) => update.updateId === key)) {
        updates.push({
          ...body,
          updateId: key,
          occurredAt: "2026-09-01T12:05:00Z",
        });
      }
      if (state.failDelivery) {
        await route.fulfill({
          status: 502,
          json: {
            error: "City update not confirmed",
            updateSaved: true,
            retryable: true,
          },
        });
        return;
      }
      await route.fulfill({ json: { task, update: updates.at(-1) } });
      return;
    }
    await route.fulfill({ json: { task, updates } });
  });
  await page.route("**/v1/checks/311-update-check/artifacts:presign", (route) =>
    route.fulfill({
      json: {
        artifactId: "update-photo",
        s3Key: "fixture/photo.jpg",
        uploadUrl: "http://127.0.0.1:5173/e2e-photo-upload",
      },
    }),
  );
  await page.route("**/e2e-photo-upload", (route) => {
    state.uploads++;
    return route.fulfill({ status: 200, body: "" });
  });
  await page.route("**/v1/tasks/311-update-fixture/update-media", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route(
    "**/v1/checks/311-update-check/artifacts/update-photo/media",
    (route) =>
      route.fulfill({
        json: { downloadUrl: "http://127.0.0.1:5173/e2e-photo.jpg" },
      }),
  );
  await page.route("**/e2e-photo.jpg", (route) =>
    route.fulfill({ path: PHOTO_ISSUES, contentType: "image/jpeg" }),
  );
  await page.goto("/today?filter=in_progress");
  const card = page.locator('[data-task-id="311-update-fixture"]');
  await card.locator('[data-action="update"]').click();
  await expect(page.locator('[data-mode="notes"]')).toBeVisible();
  return state;
}

for (const width of [393, 1178]) {
  for (const mode of ["notes", "action"]) {
    test(`311 ${mode}: content gating, stable Done, save and return at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1100 });
      const state = await filedTicket(page);
      const dialog = page.locator("dialog.task-update[open]");
      const launch = () => dialog.locator(`[data-mode="${mode}"]`).click();
      await launch();
      await dialog.locator("[data-close]").click();
      await expect(dialog.locator(`[data-mode="${mode}"]`)).toBeVisible();
      await launch();
      const yes = dialog.locator('[data-city-help="yes"]');
      const no = dialog.locator('[data-city-help="no"]');
      const done = dialog.locator(
        mode === "notes" ? "[data-save-notes]" : "[data-save-action]",
      );
      await expect(yes).toBeDisabled();
      await expect(no).toBeDisabled();
      await expect(done).toBeDisabled();
      if (mode === "notes") {
        await dialog.locator("[data-photos]").setInputFiles(PHOTO_ISSUES);
        await expect(yes).toBeEnabled();
        await expect(no).toBeEnabled();
        await expect(done).toBeDisabled();
        await dialog.locator("[data-photos]").setInputFiles([]);
        await expect(yes).toBeDisabled();
        await expect(no).toBeDisabled();
        await dialog.locator("[data-add-note]").click();
        await dialog.locator("[data-note-text]").fill("A saved 311 note");
        await dialog.locator("[data-save-note]").click();
        await dialog.locator("[data-photos]").setInputFiles(PHOTO_ISSUES);
      } else {
        await dialog.locator("[data-action-text]").fill(" ");
        await expect(yes).toBeDisabled();
        await dialog.locator("[data-action-text]").fill("a");
      }
      await expect(yes).toBeEnabled();
      await expect(no).toBeEnabled();
      await expect(done).toBeDisabled();
      const before = await done.boundingBox();
      await no.click();
      await expect(dialog.locator("#city-help-note")).toHaveText(
        t("taskUpdate.cityHelp.notice"),
      );
      await expect(dialog.locator("#city-help-note")).toBeVisible();
      await expect(done).toBeEnabled();
      const after = await done.boundingBox();
      expect(after?.y).toBe(before?.y);
      await yes.click();
      await expect(dialog.locator("#city-help-note")).toBeHidden();
      expect((await done.boundingBox())?.y).toBe(before?.y);
      if (mode === "action") {
        await dialog.locator("[data-clear]").click();
        await expect(yes).toBeDisabled();
        await expect(no).toBeDisabled();
        await expect(done).toBeDisabled();
        await dialog.locator("[data-action-text]").fill("Called the agency");
        await no.click();
      }
      await done.click();
      await expect(dialog.locator('[data-mode="notes"]')).toBeVisible();
      const content =
        mode === "notes" ? "A saved 311 note" : "Called the agency";
      await expect(dialog.locator(".task-update__timeline")).toContainText(
        content,
      );
      expect(state.requests).toHaveLength(1);
      expect(state.requests[0].body.cityHelpNeeded).toBe(mode === "notes");
      expect(state.requests[0].body.type).toBe(
        mode === "notes" ? "note_photo_update" : "additional_action",
      );
      if (mode === "notes") {
        expect(state.requests[0].body.photoKeys).toEqual(["update-photo"]);
        expect(state.uploads).toBe(1);
        await expect(
          dialog.locator(".task-update__timeline img"),
        ).toBeVisible();
      }
      await page.reload();
      await page
        .locator('[data-task-id="311-update-fixture"] [data-action="update"]')
        .click();
      await expect(dialog.locator(".task-update__timeline")).toContainText(
        content,
      );
      if (mode === "notes")
        await expect(
          dialog.locator(".task-update__timeline img"),
        ).toBeVisible();
      // Discarding an editor draft returns to the timeline without another event.
      await launch();
      if (mode === "notes") {
        await dialog.locator("[data-add-note]").click();
        await dialog.locator("[data-note-text]").fill("Unsaved note");
      } else await dialog.locator("[data-action-text]").fill("Unsaved action");
      await dialog.locator("[data-close]").click();
      await page.locator("[data-confirm-discard]").click();
      await expect(dialog.locator(`[data-mode="${mode}"]`)).toBeVisible();
      expect(state.updates).toHaveLength(1);
      // Simulate a later City closure: previously saved content remains in history.
      state.task.status = "completed";
      state.task.completedAt = "2026-09-01T13:00:00Z";
      await page.goto("/today?filter=history");
      await page
        .locator('[data-task-id="311-update-fixture"] [data-action="update"]')
        .click();
      await expect(dialog.locator(".task-update__timeline")).toContainText(
        content,
      );
      if (mode === "notes")
        await expect(
          dialog.locator(".task-update__timeline img"),
        ).toBeVisible();
      await expect(dialog.locator('[data-mode="notes"]')).toHaveCount(0);
      await expect(dialog.locator('[data-mode="action"]')).toHaveCount(0);
    });
  }
}

test("311 delivery retry keeps the saved event and request identity", async ({
  page,
}) => {
  const state = await filedTicket(page);
  state.failDelivery = true;
  const dialog = page.locator("dialog.task-update[open]");
  await dialog.locator('[data-mode="action"]').click();
  await dialog
    .locator("[data-action-text]")
    .fill("No further City help needed");
  await dialog.locator('[data-city-help="no"]').click();
  await dialog.locator("[data-save-action]").click();
  await expect(
    page.getByText(t("toast.cityUpdateError.title"), { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator("[data-action-text]")).toHaveValue(
    "No further City help needed",
  );
  await expect(dialog.locator("[data-save-action]")).toBeEnabled();
  state.failDelivery = false;
  await dialog.locator("[data-save-action]").click();
  await expect(dialog.locator('[data-mode="action"]')).toBeVisible();
  expect(state.requests).toHaveLength(2);
  expect(state.requests[0].key).toBeTruthy();
  expect(state.requests[1]).toEqual(state.requests[0]);
  expect(state.updates).toHaveLength(1);
  await expect(dialog.locator(".task-update__timeline")).toContainText(
    "No further City help needed",
  );
});

for (const mode of ["notes", "action"]) {
  test(`311 nested ${mode} editor: Back respects drafts and returns to ticket`, async ({
    page,
  }) => {
    const state = await filedTicket(page);
    await page.locator("dialog.task-update[open] [data-close]").click();
    await expect(page.locator("dialog.task-update[open]")).toHaveCount(0);
    await page.route(
      "**/v1/tasks/311-update-fixture/311-requests/123456",
      (route) =>
        route.fulfill({
          json: { request: { srNum: "123456", status: "Open", updates: [] } },
        }),
    );
    // Exercise the dedicated 311 component's public entry point. Current cards
    // primarily use the shared timeline, but this nested host remains supported.
    await page.evaluate(async (task) => {
      await window.customElements.whenDefined("ticket-detail-dialog");
      const ticket = /** @type {any} */ (
        document.createElement("ticket-detail-dialog")
      );
      document.body.append(ticket);
      await ticket.open(task);
    }, state.task);
    const ticket = page.locator("#ticket-detail-dialog[open]");
    await expect(ticket.locator(`[data-mode="${mode}"]`)).toBeVisible();
    await ticket.locator(`[data-mode="${mode}"]`).click();
    const editor = page.locator("dialog.task-update[open]");
    await expect(editor).toBeVisible();
    await page.goBack();
    await expect(editor).toHaveCount(0);
    await expect(ticket).toBeVisible();
    await expect(page).toHaveURL(/#ticket-detail$/);
    await ticket.locator(`[data-mode="${mode}"]`).click();
    if (mode === "notes") {
      await editor.locator("[data-add-note]").click();
      await editor.locator("[data-note-text]").fill("Keep this draft");
    } else await editor.locator("[data-action-text]").fill("Keep this draft");
    await page.goBack();
    const discard = page.locator("[data-discard-dialog][open]");
    await expect(discard).toBeVisible();
    await discard.locator("[data-continue-editing]").click();
    await expect(
      editor.locator(
        mode === "notes" ? "[data-note-text]" : "[data-action-text]",
      ),
    ).toHaveValue("Keep this draft");
    await expect(page).toHaveURL(/#task-update-editor$/);
    await page.goBack();
    await discard.locator("[data-confirm-discard]").click();
    await expect(editor).toHaveCount(0);
    await expect(ticket).toBeVisible();
    await expect(page).toHaveURL(/#ticket-detail$/);
    await ticket.locator(`[data-mode="${mode}"]`).click();
    if (mode === "notes") {
      await editor.locator("[data-add-note]").click();
      await editor.locator("[data-note-text]").fill("Saved from nested editor");
      await editor.locator("[data-save-note]").click();
    } else
      await editor
        .locator("[data-action-text]")
        .fill("Saved from nested editor");
    await editor.locator('[data-city-help="yes"]').click();
    await editor
      .locator(mode === "notes" ? "[data-save-notes]" : "[data-save-action]")
      .click();
    await expect(editor).toHaveCount(0);
    await expect(ticket).toContainText("Saved from nested editor");
    await expect(page).toHaveURL(/#ticket-detail$/);
    await page.goBack();
    await expect(ticket).toHaveCount(0);
    expect(state.requests).toHaveLength(1);
  });
}
