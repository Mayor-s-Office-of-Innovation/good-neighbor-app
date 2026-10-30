import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t } from "../helpers/i18n.js";

test.beforeEach(async ({ page }) => {
  await page.route("**/__notice_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><title>Error states</title></head><body><main id="view"><section><h1>Example form</h1><label>Draft<input id="draft" value="Keep this work"></label></section></main><dialog aria-label="Example dialog"><button id="cancel">Cancel</button></dialog><script type="module">
import '/src/styles/tokens.css';
import '/src/styles/base.css';
import { startErrorPresentation } from '/src/components/error-notice.js';
import { mountConnectionBanner } from '/src/components/connection-banner.js';
startErrorPresentation(); mountConnectionBanner(); window.ready = true;
</script></body></html>`,
    }),
  );
  await page.goto("/__notice_test");
  await page.waitForFunction(() => window.ready);
});

test("dynamic inline error has icon, preserves draft, and transient refresh warning expires", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const { showInlineError } = await import("/src/components/error-notice.js");
    const target = document.querySelector("#view section");
    showInlineError("Could not save. Try again.", {
      target,
      key: "save",
      retry: () => {
        window.retried = true;
      },
    });
    showInlineError("Saved. Could not refresh.", {
      target,
      key: "refresh",
      duration: 5000,
      warning: true,
    });
  });
  await expect(page.locator('[data-operation-error="save"]')).toBeVisible();
  await expect(page.locator("#draft")).toHaveValue("Keep this work");
  expect(
    await page
      .locator('[data-operation-error="save"]')
      .evaluate((el) => window.getComputedStyle(el, "::before").maskImage),
  ).toContain("triangle-exclamation");
  await page.locator('[data-operation-error="save"] button').focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.retried);
  await expect(page.locator('[data-operation-error="refresh"]')).toHaveCount(
    0,
    { timeout: 6500 },
  );
  await expect(page.locator('[data-operation-error="save"]')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include("#view").analyze()).violations,
  ).toEqual([]);
  await page.screenshot({
    path: `test-results/inline-error-${test.info().project.name}.png`,
  });
});

test("connection banner remains above modal, recovers only when all services do, then expires", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const state = await import("/src/services/backend-health.js");
    state.connectionFailed("api");
    state.connectionFailed("upload:example");
    document.querySelector("dialog").showModal();
  });
  const banner = page.locator(".app-connection-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(t("notice.disconnected"));
  expect(
    await page
      .locator("connection-banner")
      .evaluate((el) => el.matches(":popover-open")),
  ).toBe(true);
  await page.evaluate(async () =>
    (await import("/src/services/backend-health.js")).connectionSucceeded(
      "api",
    ),
  );
  await expect(banner).not.toContainText(t("notice.online"));
  await page.locator("[data-connection-retry]").click();
  await page.evaluate(async () =>
    (await import("/src/services/backend-health.js")).connectionSucceeded(
      "upload:example",
    ),
  );
  await expect(banner).toContainText(t("notice.online"));
  await expect(page.locator("[data-connection-retry]")).toBeHidden();
  await page.screenshot({
    path: `test-results/connection-banner-${test.info().project.name}.png`,
  });
  await expect(banner).toBeHidden({ timeout: 6500 });
  await expect(page.locator("dialog:modal")).toBeVisible();
});

test("oversized complaint file can be replaced without losing description or other files", async ({
  page,
}) => {
  await page.evaluate(async () => {
    window.history.replaceState({}, "", "/complaints/new");
    await import("/src/components/complaint-view.js");
    const host = document.createElement("complaint-view");
    document.querySelector("#view").replaceChildren(host);
    await host._selectFiles([
      new window.File([new Uint8Array(11 * 1024 * 1024)], "oversized.jpg", {
        type: "image/jpeg",
      }),
    ]);
  });
  const row = page.locator(".complaint-file");
  await expect(row).toContainText("oversized.jpg");
  await expect(row.locator("[data-replace-file]")).toBeVisible();
  await expect(row.locator("[data-retry-file]")).toHaveCount(0);
  await expect(page.locator("#submit-complaint")).toBeDisabled();
  await page.screenshot({
    path: `test-results/complaint-upload-${test.info().project.name}.png`,
  });
});

test("failed complaint deletion remains in its modal and can be cancelled or retried", async ({
  page,
}) => {
  await page.route("**/v1/complaints**", (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 500, json: { error: "temporary_failure" } })
      : route.fulfill({
          json: {
            complaints: [
              {
                complaintId: "synthetic",
                status: "analyzed",
                label: "Example complaint",
                createdAt: "2026-10-29T12:00:00Z",
              },
            ],
          },
        }),
  );
  await page.evaluate(async () => {
    window.history.replaceState({}, "", "/complaints");
    const { setSite } = await import("/src/db.js");
    await setSite("Example site", {
      siteId: "example",
      deviceId: "synthetic-device",
      token: "synthetic-test-token",
    });
    await import("/src/components/complaint-view.js");
    document
      .querySelector("#view")
      .replaceChildren(document.createElement("complaint-view"));
  });
  await page.locator('[data-delete="synthetic"]').click();
  await page.locator("#delete-confirm").click();
  await expect(
    page.locator("#complaint-delete:modal [data-delete-error]"),
  ).toBeVisible();
  await expect(page.locator("#delete-confirm")).toBeEnabled();
  await expect(page.locator('[data-complaint-row="synthetic"]')).toHaveCount(1);
  await page.screenshot({
    path: `test-results/complaint-delete-${test.info().project.name}.png`,
  });
  expect(
    (await new AxeBuilder({ page }).include("#complaint-delete").analyze())
      .violations,
  ).toEqual([]);
  await page.locator('#complaint-delete button[type="submit"]').click();
  await expect(page.locator("#complaint-delete")).toBeHidden();
});

test("upload retry reuses its reservation and preserves the other attachment", async ({
  page,
}) => {
  let presigns = 0,
    puts = 0;
  await page.route("**/v1/complaints/**", (route) => {
    if (route.request().url().endsWith("artifacts:presign")) {
      presigns++;
      return route.fulfill({
        json: {
          artifactId: `artifact-${presigns}`,
          s3Key: `synthetic-${presigns}`,
          uploadUrl: `http://127.0.0.1:5182/__upload/${presigns}`,
          expiresIn: 300,
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/__upload/*", (route) => {
    puts++;
    return puts === 2 ? route.abort("failed") : route.fulfill({ status: 200 });
  });
  await page.evaluate(async () => {
    window.history.replaceState({}, "", "/complaints/new");
    const { setSite } = await import("/src/db.js");
    await setSite("Example", {
      siteId: "example",
      deviceId: "synthetic-device",
      token: "synthetic-test-token",
    });
    await import("/src/components/complaint-view.js");
    const host = document.createElement("complaint-view");
    document.querySelector("#view").replaceChildren(host);
    await host._selectFiles([
      new window.File(["a"], "first.jpg", { type: "image/jpeg" }),
      new window.File(["b"], "second.jpg", { type: "image/jpeg" }),
    ]);
  });
  await expect(page.locator(".complaint-file")).toHaveCount(2);
  await expect(page.locator("[data-retry-file]")).toHaveCount(1);
  await page.locator("[data-retry-file]").click();
  await expect(page.locator("[data-retry-file]")).toHaveCount(0);
  await expect(page.locator(".complaint-file")).toHaveCount(2);
  expect(presigns).toBe(2);
  expect(puts).toBe(3);
});

test("error cards retain the supplied illustrations at their intrinsic geometry", async ({
  page,
}) => {
  await page.evaluate(async () => {
    await import("/src/components/analysis-results.css");
    const { analysisCards } = await import(
      "/src/components/analysis-results.templates.js"
    );
    const host = document.querySelector("#view section");
    host.innerHTML =
      "<h1>Error cards</h1>" +
      [
        ...analysisCards(
          {
            id: "upload",
            kind: "photo",
            analysis: { status: "failed", failure: { leg: "upload" } },
          },
          "synthetic",
        ),
        ...analysisCards(
          {
            id: "analysis",
            kind: "photo",
            analysis: {
              status: "failed",
              failure: { leg: "analyze", uploaded: true },
            },
          },
          "synthetic",
        ),
        ...analysisCards(
          {
            id: "saved",
            kind: "photo",
            analysis: {
              status: "failed",
              localSaveConfirmed: true,
              retryCount: 3,
            },
          },
          "synthetic",
        ),
      ].join("");
  });
  const images = page.locator(".analysis-error__illustration");
  await expect(images).toHaveCount(2);
  for (const img of await images.all()) {
    await expect(img).toHaveJSProperty("naturalWidth", 118);
    expect(await img.evaluate((el) => el.getBoundingClientRect().width)).toBe(
      118,
    );
  }
  await expect(page.locator(".analysis-saved__illustration")).toHaveJSProperty(
    "naturalWidth",
    58,
  );
  await page.screenshot({
    path: `test-results/error-cards-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test("Try again stays disconnected while the browser is offline", async ({
  page,
  context,
}) => {
  await page.route("**/health", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await context.setOffline(true);
  const banner = page.locator(".app-connection-banner");
  await expect(banner).toContainText(t("notice.disconnected"));
  await page.locator("[data-connection-retry]").click();
  await page.waitForTimeout(5500);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(t("notice.disconnected"));
  await expect(banner).not.toHaveClass(/--online/);
  await context.setOffline(false);
  await expect(banner).toContainText(t("notice.online"));
  await expect(page.locator("[data-connection-retry]")).toBeHidden();
  await expect(banner).toBeHidden({ timeout: 6500 });
});

test("recovered banner survives a modal repaint without restarting its expiry", async ({
  page,
}) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const state = await import("/src/services/backend-health.js");
    state.connectionFailed("api");
    document.querySelector("dialog").showModal();
    state.connectionSucceeded("api");
  });
  const banner = page.locator(".app-connection-banner");
  await expect(banner).toContainText(t("notice.online"));
  await page.clock.fastForward(3000);
  await page.evaluate(() =>
    document
      .querySelector("dialog")
      .replaceChildren(document.createElement("button")),
  );
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(t("notice.online"));
  await page.clock.fastForward(2100);
  await expect(banner).toBeHidden();
});

test("overlapping complaint selections cannot exceed the five-file limit", async ({
  page,
}) => {
  let release = () => {};
  const hold = new Promise((resolve) => {
    release = () => resolve(null);
  });
  let presigns = 0;
  await page.route("**/v1/complaints/**", async (route) => {
    if (route.request().url().endsWith("artifacts:presign")) {
      const id = ++presigns;
      if (id === 1) await hold;
      return route.fulfill({
        json: {
          artifactId: `a-${id}`,
          s3Key: `key-${id}`,
          uploadUrl: `http://127.0.0.1:5182/__upload/${id}`,
          expiresIn: 300,
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.route("**/__upload/*", (route) => route.fulfill({ status: 200 }));
  try {
    await page.evaluate(async () => {
      window.history.replaceState({}, "", "/complaints/new");
      const { setSite } = await import("/src/db.js");
      await setSite("Example", {
        siteId: "example",
        deviceId: "synthetic-device",
        token: "synthetic-test-token",
      });
      await import("/src/components/complaint-view.js");
      const host = document.createElement("complaint-view");
      document.querySelector("#view").replaceChildren(host);
      window.batch = host._selectFiles(
        ["one", "two", "three"].map(
          (name) =>
            new window.File(["a"], `${name}.jpg`, { type: "image/jpeg" }),
        ),
      );
    });
    await expect(page.locator(".complaint-file")).toHaveCount(3);
    await page.evaluate(async () =>
      document
        .querySelector("complaint-view")
        ._selectFiles(
          ["four", "five", "six"].map(
            (name) =>
              new window.File(["a"], `${name}.jpg`, { type: "image/jpeg" }),
          ),
        ),
    );
    await expect(page.locator(".complaint-file")).toHaveCount(3);
    await expect(
      page.locator('.complaint-compose [role="alert"]'),
    ).toBeVisible();
    release();
    await page.evaluate(() => window.batch);
    expect(presigns).toBe(3);
    await expect(page.locator(".complaint-file")).toHaveCount(3);
  } finally {
    release();
  }
});

for (const removal of [
  "artifact_not_found",
  "complaint_not_found",
  "temporary_failure",
]) {
  test(`uncertain attachment removal handles ${removal} precisely`, async ({
    page,
  }) => {
    await page.route("**/v1/complaints/**", (route) => {
      if (route.request().method() === "DELETE")
        return route.fulfill({
          status: removal === "temporary_failure" ? 500 : 404,
          json: { error: removal },
        });
      if (route.request().url().endsWith("artifacts:presign"))
        return route.fulfill({
          json: {
            artifactId: "synthetic",
            s3Key: "synthetic",
            uploadUrl: "http://127.0.0.1:5182/__upload/1",
            expiresIn: 300,
          },
        });
      return route.fulfill({ status: 400, json: { error: "invalid_media" } });
    });
    await page.route("**/__upload/*", (route) =>
      route.fulfill({ status: 200 }),
    );
    await page.evaluate(async () => {
      window.history.replaceState({}, "", "/complaints/new");
      const { setSite } = await import("/src/db.js");
      await setSite("Example", {
        siteId: "example",
        deviceId: "synthetic-device",
        token: "synthetic-test-token",
      });
      await import("/src/components/complaint-view.js");
      const host = document.createElement("complaint-view");
      document.querySelector("#view").replaceChildren(host);
      await host._selectFiles([
        new window.File(["invalid"], "invalid.jpg", { type: "image/jpeg" }),
      ]);
    });
    await expect(page.locator("[data-retry-file]")).toHaveCount(1);
    await page.locator("[data-remove-file]").click();
    await expect(page.locator(".complaint-file")).toHaveCount(
      removal === "artifact_not_found" ? 0 : 1,
    );
    if (removal !== "artifact_not_found")
      await expect(
        page
          .locator(".app-error[role=alert]")
          .filter({ hasText: t("complaints.upload.removeError") }),
      ).toContainText(t("complaints.upload.removeError"));
  });
}

test("mobile wrapped banner reserves page and toast space without measurements", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(async () => {
    await import("/src/components/app-toasts.js");
    document.body.append(document.createElement("app-toasts"));
    const { connectionFailed } = await import(
      "/src/services/backend-health.js"
    );
    connectionFailed("api");
    const { showToast } = await import("/src/state/toasts.js");
    showToast({ title: "Example notification", message: "Example text" });
  });
  const banner = page.locator("connection-banner .app-connection-banner");
  await expect(banner).toBeVisible();
  const bounds = await banner.boundingBox();
  const pageBounds = await page.locator("#view").boundingBox();
  const toastBounds = await page.locator(".app-toast").boundingBox();
  expect(pageBounds.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
  expect(toastBounds.y).toBeGreaterThanOrEqual(bounds.y + bounds.height);
  await page.locator("[data-connection-retry]").focus();
  await expect(page.locator("[data-connection-retry]")).toBeFocused();
});

test("upload and auth recover through host checks without replaying writes", async ({
  page,
}) => {
  const probes = [];
  for (const host of ["uploads.example.test", "login.example.test"]) {
    await page.route(`https://${host}/**`, (route) => {
      const request = route.request();
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname === "/"
      ) {
        probes.push(request.url());
        return route.fulfill({ status: 403, body: "" });
      }
      return route.abort("failed");
    });
  }
  await page.evaluate(async () => {
    const { connectionFetch } = await import("/src/services/backend-health.js");
    await connectionFetch(
      "https://uploads.example.test/object?signature=synthetic",
      { method: "PUT", body: "synthetic" },
    ).catch(() => {});
    await connectionFetch("https://login.example.test/oauth2/token", {
      method: "POST",
      body: "synthetic",
    }).catch(() => {});
  });
  await expect(page.locator("connection-banner")).toContainText(
    t("notice.disconnected"),
  );
  await page.locator("[data-connection-retry]").click();
  await expect(page.locator("connection-banner")).toContainText(
    t("notice.online"),
  );
  expect(probes.sort()).toEqual([
    "https://login.example.test/",
    "https://uploads.example.test/",
  ]);
});
