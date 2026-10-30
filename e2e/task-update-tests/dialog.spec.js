import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const task = {
  taskId: "issue",
  checkId: "check",
  status: "completing",
  canUpdate: true,
  canUploadPhotos: true,
  userFriendlyLabel: "Graffiti",
  shortId: "GUB-STJ-082",
};

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/v1/tasks/issue/updates", (route) =>
    route.fulfill({ json: { task, updates: [] } }),
  );
  await page.route("**/__update_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Issue updates</title></head><body><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__update_test");
  await page.evaluate(async (task) => {
    const load = (/** @type {string} */ path) => import(path);
    await load("/src/components/task-update-dialog.js");
    const { setSite } = await load("/src/db.js");
    await setSite("Test site", {
      siteId: "test-site",
      deviceId: "test-device",
      token: "test-token",
    });
    const dialog = /** @type {any} */ (
      document.createElement("task-update-dialog")
    );
    document.body.append(dialog);
    await dialog.open(task);
    dialog.querySelector("dialog").dataset.testIdentity = "original";
  }, task);
});

/** @param {import("@playwright/test").Page} page */
async function pickPhoto(page) {
  await page.locator('[data-mode="notes"]').click();
  await page
    .locator("[data-photos], [data-update-camera]")
    .setInputFiles("e2e/fixtures/photos/input-1.jpg");
  await expect(page.locator("dialog.task-update")).toHaveAttribute(
    "data-test-identity",
    "original",
  );
  await expect(page.locator("[data-save-notes]")).toBeEnabled();
}

test("all actions are available on a recoverable issue; picking a photo keeps the modal operable", async ({
  page,
}) => {
  for (const mode of ["notes", "action", "resolve"])
    await expect(page.locator(`[data-mode="${mode}"]`)).toBeEnabled();
  await pickPhoto(page);
  await page.evaluate(() => {
    const host = document.querySelector("task-update-dialog");
    host?.remove();
    if (host) document.body.append(host);
  });
  await expect(page.locator("dialog.task-update:modal")).toBeVisible();
  await expect(page.locator("dialog.task-update")).toHaveAttribute(
    "data-test-identity",
    "original",
  );
  await page.locator("[data-add-note], [data-capture-text]").click();
  await page.locator("[data-note-text]").fill("An update");
  await page.locator("[data-save-note]").click();
  await page.locator("[data-close]").click();
  await expect(page.locator("[data-discard-dialog]")).toBeVisible();
  await page.locator("[data-continue-editing]").click();
  await expect(page.locator("[data-save-notes]")).toBeEnabled();
  const results = await new AxeBuilder({ page })
    .include("dialog.task-update")
    .analyze();
  expect(results.violations).toEqual([]);
  await page.locator("[data-close]").focus();
  await page.keyboard.press("Enter");
  await page.locator("[data-confirm-discard]").click();
  await expect(page.locator('[data-mode="notes"]')).toBeVisible();
});

for (const cancelControl of ["data-cancel-save", "data-close"])
  test(`stalled upload can exit via ${cancelControl} and retry without refreshing`, async ({
    page,
  }) => {
    let presigns = 0;
    let saves = 0;
    /** @type {string[]} */
    const requestIds = [];
    await page.route("**/v1/checks/check/artifacts:presign", (route) => {
      presigns++;
      requestIds.push(route.request().postDataJSON().uploadRequestId);
      return route.fulfill({
        json: {
          artifactId: "photo-1",
          s3Key: "photo",
          uploadUrl: `http://127.0.0.1:${process.env.E2E_UPDATES_PORT ?? 5179}/test-upload`,
          uploadHeaders: {},
        },
      });
    });
    await page.route("**/test-upload", () => {});
    await page.route("**/v1/tasks/issue/updates", async (route) => {
      if (route.request().method() === "POST") saves++;
      await route.fulfill({
        json: { task: { ...task, status: "in_progress" }, updates: [] },
      });
    });
    await pickPhoto(page);
    await page.locator("[data-save-notes]").click();
    await expect.poll(() => presigns).toBe(1);
    await expect(page.locator("[data-cancel-save]")).toBeVisible();
    await expect(page.locator("[data-capture-upload]")).toBeHidden();
    await expect(page.locator("[data-photo-upload-status]")).toBeVisible();
    await page.locator(`[${cancelControl}]`).click();
    if (cancelControl === "data-close") {
      await expect(page.locator("[data-discard-dialog]")).toBeVisible();
      await page.locator("[data-continue-editing]").click();
    }
    await expect(page.locator("[data-cancel-save]")).toBeHidden();
    await expect(page.locator("[data-save-notes]")).toBeEnabled();
    expect(saves).toBe(0);
    await page.unroute("**/test-upload");
    await page.route("**/test-upload", (route) =>
      route.fulfill({ status: 200, body: "" }),
    );
    await page.locator("[data-save-notes]").click();
    await expect(page.locator('[data-mode="notes"]')).toBeVisible();
    expect(saves).toBe(1);
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBeTruthy();
    expect(requestIds[1]).toBe(requestIds[0]);
  });

test("an uncertain save times out and retry reuses the update identity", async ({
  page,
}) => {
  /** @type {string[]} */
  const ids = [];
  await page.clock.install();
  await page.route("**/v1/tasks/issue/updates", async (route) => {
    if (route.request().method() === "POST") {
      ids.push(route.request().headers()["idempotency-key"]);
      if (ids.length === 1) return;
    }
    await route.fulfill({
      json: { task: { ...task, status: "in_progress" }, updates: [] },
    });
  });
  await page.locator('[data-mode="notes"]').click();
  await page.locator("[data-add-note], [data-capture-text]").click();
  await page.locator("[data-note-text]").fill("A note to retain");
  await page.locator("[data-save-note]").click();
  await page.locator("[data-save-notes]").click();
  await expect.poll(() => ids.length).toBe(1);
  await page.clock.fastForward(120_000);
  await expect(page.locator("[data-cancel-save]")).toBeHidden();
  await expect(page.locator("[data-edit-note]")).toHaveText("A note to retain");
  await page.locator("[data-save-notes]").click();
  await expect(page.locator('[data-mode="notes"]')).toBeVisible();
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
});

test("identical attachments receive distinct artifacts in one task update", async ({
  page,
}) => {
  const reservations = new Map();
  let savedPhotos;
  await page.route("**/v1/checks/check/artifacts:presign", (route) => {
    const id = route.request().postDataJSON().uploadRequestId;
    if (!reservations.has(id))
      reservations.set(id, `photo-${reservations.size + 1}`);
    const artifactId = reservations.get(id);
    return route.fulfill({
      json: {
        artifactId,
        s3Key: artifactId,
        uploadUrl: "http://127.0.0.1:5179/test-upload",
        uploadHeaders: {},
      },
    });
  });
  await page.route("**/test-upload", (route) =>
    route.fulfill({ status: 200, body: "" }),
  );
  await page.route("**/v1/tasks/issue/updates", (route) => {
    if (route.request().method() === "POST")
      savedPhotos = route.request().postDataJSON().photoKeys;
    return route.fulfill({
      json: { task: { ...task, status: "in_progress" }, updates: [] },
    });
  });
  await page.locator('[data-mode="notes"]').click();
  const file = "e2e/fixtures/photos/input-1.jpg";
  await page
    .locator("[data-upload-input], [data-update-gallery]")
    .setInputFiles([file, file]);
  await page.locator("[data-save-notes]").click();
  await expect.poll(() => savedPhotos?.length).toBe(2);
  expect(reservations.size).toBe(2);
  expect(new Set(savedPhotos).size).toBe(2);
});

test("proof saves only after success, retains a failed draft, and supports keyboard dismissal", async ({
  page,
}) => {
  const completed = {
    ...task,
    status: "completed",
    completionMethod: "site_team_resolved",
    proofAddedAt: null,
  };
  let attempts = 0;
  await page.route("**/v1/tasks/issue/updates", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toMatchObject({
        type: "resolution_proof",
        notes: ["The area is clean"],
      });
      if (++attempts === 1)
        return route.fulfill({
          status: 500,
          json: { error: "Temporary failure" },
        });
      return route.fulfill({
        json: {
          task: { ...completed, proofAddedAt: "2026-10-28" },
          update: {},
        },
      });
    }
    return route.fulfill({ json: { task: completed, updates: [] } });
  });
  await page.evaluate(async (completed) => {
    const dialog = /** @type {any} */ (
      document.querySelector("task-update-dialog")
    );
    await dialog.openProof(completed);
  }, completed);
  await expect(page.locator("#task-update-title")).toHaveText(
    "Share how things look now",
  );
  await expect(page.locator("[data-save-notes]")).toBeDisabled();
  await page.locator("[data-add-note]").focus();
  await page.keyboard.press("Enter");
  await page.locator("[data-note-text]").fill("The area is clean");
  await page.locator("[data-save-note]").click();
  await page.locator("[data-save-notes]").click();
  await expect(page.locator("[data-edit-note]")).toHaveText(
    "The area is clean",
  );
  await expect(page.locator("[data-save-notes]")).toBeEnabled();
  expect(
    (await new AxeBuilder({ page }).include("dialog.task-update").analyze())
      .violations,
  ).toEqual([]);
  await page.locator("[data-save-notes]").click();
  await expect(page.locator("dialog.task-update:modal")).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("history proof button and orange ticker remain accessible on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    /** @type {any} */ (
      document.querySelector("task-update-dialog")
    )?._dismiss();
    const { taskAnalysisCard } = await load(
      "/src/components/analysis-results.templates.js",
    );
    await load("/src/components/analysis-results.css");
    const host = document.createElement("main");
    host.id = "proof-card-test";
    host.innerHTML = taskAnalysisCard({
      history: true,
      task: {
        taskId: "history-proof",
        userFriendlyLabel: "Graffiti on the wall",
        status: "completed",
        canBeInProgress: false,
        completedAt: "2026-10-28T12:00:00Z",
      },
    });
    document.body.append(host);
  });
  const card = page.locator("#proof-card-test");
  await expect(card.locator('[data-status-ticker="awaitingProof"]')).toHaveText(
    "Issue resolved - add proof",
  );
  const button = card.getByRole("button", { name: "Add proof", exact: true });
  await expect(button).toBeVisible();
  await button.focus();
  await expect(button).toBeFocused();
  expect(await card.evaluate((el) => el.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).include("#proof-card-test").analyze())
      .violations,
  ).toEqual([]);
  await card.screenshot({ path: "/tmp/good-neighbor-history-proof.png" });
});

test("proof controls have square original media, separate camera and upload pickers, and cumulative photo limits", async ({
  page,
}) => {
  await page.evaluate(async (task) => {
    const dialog = /** @type {any} */ (
      document.querySelector("task-update-dialog")
    );
    dialog.openResults({
      ...task,
      status: "completed",
      mediaUrl: "/test-photo.jpg",
    });
  }, task);
  await expect(page.locator("[data-take-photo]")).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 1000 });
  const row = await page
    .locator(".task-update__capture-secondary")
    .boundingBox();
  const note = await page.locator("[data-add-note]").boundingBox();
  const upload = await page.locator("[data-upload-photos]").boundingBox();
  if (!row || !note || !upload) throw new Error("Missing photo controls");
  expect(note.x).toBe(row.x);
  expect(upload.y).toBe(note.y);
  expect(upload.x - (note.x + note.width)).toBeCloseTo(12, 0);

  const camera = await page.locator("[data-take-photo]").boundingBox();
  expect(camera?.height).toBe(64);
  const thumb = await page.locator(".task-update__capture-thumb").boundingBox();
  expect(thumb?.width).toBe(thumb?.height);
  if (!camera || !thumb) throw new Error("Missing proof controls");
  expect(camera.y - (thumb.y + thumb.height)).toBeGreaterThanOrEqual(24);
  await expect(page.locator("[data-photos]")).toHaveAttribute(
    "capture",
    "environment",
  );
  await expect(page.locator("[data-upload-input]")).not.toHaveAttribute(
    "capture",
  );
  const chooserEvent = page.waitForEvent("filechooser");
  await page.locator("[data-upload-photos]").click();
  const chooser = await chooserEvent;
  await chooser.setFiles("e2e/fixtures/photos/input-1.jpg");
  await page
    .locator("[data-upload-input]")
    .setInputFiles("e2e/fixtures/photos/input-1.jpg");
  await expect(page.locator(".task-update__photo--draft")).toHaveCount(2);
  await page.locator("[data-upload-input]").setInputFiles({
    name: "note.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a photo"),
  });
  await expect(page.locator("[data-photo-error]")).toBeVisible();
  await expect(page.locator(".task-update__photo--draft")).toHaveCount(2);
  await page
    .locator("[data-upload-input]")
    .setInputFiles(Array(4).fill("e2e/fixtures/photos/input-1.jpg"));
  await expect(page.locator("[data-photo-error]")).toBeVisible();
  await expect(page.locator(".task-update__photo--draft")).toHaveCount(2);
  await page.locator('[data-remove-photo="0"]').click();
  await expect(page.locator(".task-update__photo--draft")).toHaveCount(1);
  await expect(page.locator("[data-upload-photos]")).toBeFocused();
  await page
    .locator("[data-upload-input]")
    .setInputFiles("e2e/fixtures/photos/input-1.jpg");
  await expect(page.locator(".task-update__photo--draft")).toHaveCount(2);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({
    path: "/tmp/good-neighbor-proof-controls.png",
    fullPage: true,
  });
  expect(
    (await new AxeBuilder({ page }).include("dialog.task-update").analyze())
      .violations,
  ).toEqual([]);
});

test("additional-action photos show rejection errors without losing the draft", async ({
  page,
}) => {
  await page.evaluate(() => {
    const dialog = /** @type {any} */ (
      document.querySelector("task-update-dialog")
    );
    dialog._mode = "action-photos";
    dialog._pendingEvent = { updateId: "action" };
    dialog._render();
  });
  await page.locator("[data-photos]").setInputFiles({
    name: "document.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("not a photo"),
  });
  await expect(page.locator("[data-photo-error]")).toBeVisible();
  await page
    .locator("[data-photos]")
    .setInputFiles("e2e/fixtures/photos/input-1.jpg");
  await expect(page.locator(".task-update__photo--draft")).toHaveCount(1);
  await expect(page.locator("[data-photo-error]")).toBeHidden();
});

test("undecodable draft photos show a removable fallback without losing the draft", async ({
  page,
}) => {
  await page.evaluate((task) => {
    const dialog = /** @type {any} */ (
      document.querySelector("task-update-dialog")
    );
    dialog.openResults({ ...task, status: "completed" });
  }, task);
  await page.locator("[data-upload-input]").setInputFiles({
    name: "unsupported.heic",
    mimeType: "image/heic",
    buffer: Buffer.from("undecodable fixture"),
  });
  await expect(page.locator("[data-preview-unavailable]")).toBeVisible();
  await expect(
    page.locator(".task-update__draft-photo [data-photo-lightbox]"),
  ).toBeHidden();
  await expect(page.locator("[data-save-notes]")).toBeEnabled();
  await page.locator("[data-add-note]").click();
  await page.locator("[data-note-text]").fill("Synthetic proof note");
  await page.locator("[data-save-note]").click();
  await expect(page.locator("[data-preview-unavailable]")).toBeVisible();
  await page.locator("[data-remove-photo]").click();
  await expect(page.locator(".task-update__draft-photo")).toHaveCount(0);
  await expect(page.locator("[data-edit-note]")).toContainText(
    "Synthetic proof note",
  );
});

test("saved HEIC rendition displays in the timeline in Chrome", async ({
  page,
}) => {
  const { readFile } = await import("node:fs/promises");
  const { heicDisplayImage } = await import(
    "../../backend/src/media/task-photo.js"
  );
  const jpeg = await heicDisplayImage(
    await readFile("backend/src/media/fixtures/synthetic.heic"),
  );
  await page.route("**/converted-proof.jpg", (route) =>
    route.fulfill({ contentType: "image/jpeg", body: jpeg }),
  );
  await page.route("**/v1/checks/check/artifacts/proof-photo/media", (route) =>
    route.fulfill({
      json: { downloadUrl: "http://127.0.0.1:5179/converted-proof.jpg" },
    }),
  );
  await page.route("**/v1/tasks/issue/updates", (route) =>
    route.fulfill({
      json: {
        task: {
          ...task,
          status: "completed",
          proofAddedAt: "2026-10-28T12:00:00Z",
        },
        updates: [
          {
            updateId: "proof",
            type: "resolution_proof",
            label: "Proof added",
            occurredAt: "2026-10-28T12:00:00Z",
            photoKeys: ["proof-photo"],
          },
        ],
      },
    }),
  );
  await page.evaluate(async (task) => {
    const dialog = /** @type {any} */ (
      document.querySelector("task-update-dialog")
    );
    await dialog.open({ ...task, status: "completed" });
  }, task);
  const img = page.locator(".task-update__timeline img");
  await expect(img).toBeVisible();
  await expect
    .poll(() =>
      img.evaluate(
        (node) => /** @type {HTMLImageElement} */ (node).naturalWidth,
      ),
    )
    .toBe(48);
});

test("timeline photos retain the original URL and keyboard focus through enrichment", async ({
  page,
}) => {
  await page.route("**/test-original.jpg", (route) =>
    route.fulfill({ path: "e2e/fixtures/photos/input-1.jpg" }),
  );
  await page.route("**/test-thumbnail.jpg", (route) =>
    route.fulfill({ path: "e2e/fixtures/photos/input-1.jpg" }),
  );
  await page.route("**/v1/checks/check/artifacts/photo/media", (route) =>
    route.fulfill({
      json: {
        downloadUrl: "http://127.0.0.1:5179/test-original.jpg",
        thumbnailUrl: "http://127.0.0.1:5179/test-thumbnail.jpg",
        expiresIn: 300,
      },
    }),
  );
  await page.route("**/v1/tasks/issue/updates", (route) =>
    route.fulfill({
      json: {
        task,
        updates: [
          {
            type: "note_photo_update",
            updateId: "update",
            occurredAt: "2026-10-28T12:00:00Z",
            photoKeys: ["photo"],
          },
        ],
      },
    }),
  );
  await page.evaluate(async (task) => {
    const element = document.querySelector("task-update-dialog");
    if (!element) throw new Error("Task update dialog is missing");
    const dialog =
      /** @type {Element & {open: (task: Record<string, unknown>) => Promise<void>}} */ (
        element
      );
    await dialog.open(task);
  }, task);
  const trigger = page.locator(".task-update__photo-trigger");
  await expect(trigger).toHaveAttribute("data-full-src", /test-original\.jpg$/);
  await expect(trigger.locator("img")).toHaveAttribute(
    "data-src",
    /test-thumbnail\.jpg$/,
  );
  await trigger.focus();
  await page.evaluate(() => {
    const element = document.querySelector("task-update-dialog");
    if (!element) throw new Error("Task update dialog is missing");
    const dialog = /** @type {Element & {_renderTimeline: () => void}} */ (
      element
    );
    dialog._renderTimeline();
  });
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("data-full-src", /test-original\.jpg$/);
});
