import { test, expect } from "../helpers/harness.js";
import { t } from "../helpers/i18n.js";
import { E2E_URLS } from "../helpers/ports.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

/**
 * @param {import("@playwright/test").Page} page
 */
async function openLogs(page) {
  await page.locator("#home-action-menu-trigger").click();
  const action = page.locator("#view-care-work");
  await expect(action).toHaveText(t("care.menu"));
  await expect
    .poll(() =>
      action
        .locator("wa-icon")
        .evaluate((el) => Boolean(el.shadowRoot?.querySelector("svg"))),
    )
    .toBe(true);
  await action.click();
  await expect(page.locator("care-work-view h1")).toHaveText(t("care.title"));
  await expect(page.locator(".care-days")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
/**
 * @param {import("@playwright/test").Page} page
 * @param {string} kind
 */
async function choose(page, kind) {
  await page.locator("[data-new]").click();
  await expect(page.locator("[data-kind]")).toHaveCount(10);
  await page.locator(`[data-kind="${kind}"]`).click();
}
/**
 * @param {import("@playwright/test").Page} page
 */
async function save(page, retry = false) {
  const response = page.waitForResponse(
    (res) =>
      res.url().endsWith("/v1/care-work") && res.request().method() === "POST",
  );
  await page.locator(retry ? "[data-retry-work]" : "[data-save]").click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const { work } = await result.json();
  await expect(page).toHaveURL(/\/care-work$/);
  await expect(page.locator(`[data-work="${work.workId}"]`)).toBeVisible();
  return work;
}
test.describe("proactive care", () => {
  test("logs a fixed option without evidence and unwinds the form stack", async ({
    page,
  }) => {
    await openLogs(page);
    await choose(page, "power_washed");
    await expect(page.locator("[data-save]")).toBeEnabled();
    const work = await save(page);
    await expect(
      page.getByText(t("care.success"), { exact: true }),
    ).toBeVisible();
    await page.locator(`[data-work="${work.workId}"]`).click();
    await expect(page.locator("care-work-view h1")).toHaveText(
      t("care.kind.powerWashed"),
    );
    await expect(
      page.locator(".care-notes, [data-edit], [data-delete]"),
    ).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/care-work$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/today(?:\?filter=todo)?$/);
  });
  test("requires a custom description, supports removable photos, and opens saved media without location", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 891 });
    await openLogs(page);
    await choose(page, "other");
    await expect(page.locator("[data-save]")).toBeDisabled();
    await page
      .locator("#care-note")
      .locator("textarea")
      .fill("Swept the entry steps");
    await page.locator("#care-photo-input").setInputFiles(PHOTO_CLEAR);
    await expect(page.locator(".care-thumbnails li")).toHaveCount(1);
    await page.locator("[data-remove]").click();
    await expect(page.locator(".care-thumbnails li")).toHaveCount(0);
    await page.locator("#care-photo-input").setInputFiles(PHOTO_CLEAR);
    const work = await save(page);
    expect(work.photoCount).toBe(1);
    await page.reload();
    await page.locator(`[data-work="${work.workId}"]`).click();
    await expect(page.locator("care-work-view h1")).toHaveText(
      "Swept the entry steps",
    );
    const photo = page.locator(".care-detail-photos img");
    await expect(photo).toBeVisible();
    await expect
      .poll(() =>
        photo.evaluate(
          (el) => el instanceof window.HTMLImageElement && el.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await photo.click();
    await expect(page.locator(".photo-lightbox[open]")).toBeVisible();
    await expect(page.locator(".photo-lightbox__caption")).not.toContainText(
      "Street",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(".photo-lightbox[open]")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
  test("keeps the same submission on an uncertain response and retries without duplicating", async ({
    page,
  }) => {
    await openLogs(page);
    await choose(page, "offered_help");
    /** @type {Record<string, any>[]} */
    const submissions = [];
    let dropped = false;
    await page.route("**/v1/care-work", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submissions.push(route.request().postDataJSON());
      if (!dropped) {
        dropped = true;
        await route.fetch();
        return route.abort("failed");
      }
      return route.fallback();
    });
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-retry-work]")).toBeVisible();
    await save(page, true);
    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual(submissions[1]);
    await expect(
      page.locator(`[data-work="${submissions[0].workId}"]`),
    ).toHaveCount(1);
  });
});

test("care screens support keyboard navigation, mobile reflow, and accessible light/dark themes", async ({
  page,
}, testInfo) => {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  await page.setViewportSize({ width: 390, height: 891 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  /**
   * @param {string} name
   */
  const checkScreen = async (name) => {
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
    });
    const scan = await new AxeBuilder({ page })
      .include("care-work-view")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(scan.violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  };
  await page.locator("#home-action-menu-trigger").click();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#view-care-work")).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("menu.png") });
  await page.keyboard.press("Enter");
  await expect(page.locator(".care-days")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await checkScreen("list");
  await page.locator("[data-new]").click();
  await checkScreen("options");
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-kind="power_washed"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await checkScreen("fixed");
  await page.locator("[data-back]").click();
  await page.locator('[data-kind="other"]').click();
  await checkScreen("custom");
  await page
    .locator("#care-note")
    .locator("textarea")
    .fill("Swept and tidied the sidewalk");
  const work = await save(page);
  await page.locator(`[data-work="${work.workId}"]`).click();
  await checkScreen("detail");
  await page.emulateMedia({ colorScheme: "dark" });
  await checkScreen("detail-dark");
  await page.setViewportSize({ width: 320, height: 740 });
  await checkScreen("detail-narrow");
});

test("proactive care lets the user remove an invalid photo after validation fails", async ({
  page,
}) => {
  await openLogs(page);
  await choose(page, "cleaned_graffiti");
  await page.locator("#care-photo-input").setInputFiles({
    name: "broken.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("not an image"),
  });
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-retry-work]")).toBeVisible();
  await page.locator("[data-edit-work]").click();
  await expect(page.locator("[data-remove]")).toBeEnabled();
  await page.locator("[data-remove]").click();
  const work = await save(page);
  expect(work.photoCount).toBe(0);
});

test("proactive care groups all pages by Pacific date with capitalized headings and exact counts", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date("2026-10-16T07:30:00Z"));
  /** @param {string} workId @param {string} createdAt */
  const entry = (workId, createdAt) => ({
    workId,
    createdAt,
    kind: "power_washed",
    note: "",
    photoCount: 0,
  });
  const today = entry("today", "2026-10-16T07:15:00Z");
  const yesterdayLate = entry("yesterday-late", "2026-10-16T06:30:00Z");
  const yesterdayEarly = entry("yesterday-early", "2026-10-15T08:00:00Z");
  let pages = 0;
  await page.route("**/v1/care-work?*", async (route) => {
    pages++;
    expect(new URL(route.request().url()).searchParams.get("nextToken")).toBe(
      "page-two",
    );
    await route.fulfill({ json: { work: [yesterdayEarly, yesterdayLate] } });
  });
  await page.route("**/v1/care-work", (route) =>
    route.fulfill({
      json: { work: [yesterdayLate, today], nextToken: "page-two" },
    }),
  );
  await openLogs(page);
  await expect.poll(() => pages).toBe(1);
  const groups = page.locator(".care-day");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).locator("h2")).toHaveText(
    `${t("card.history.today")}1`,
  );
  await expect(groups.nth(1).locator("h2")).toHaveText(
    `${t("card.history.yesterday")}2`,
  );
  await expect(groups.nth(1).locator("h2 span")).toHaveAttribute(
    "aria-label",
    t("care.count", { count: 2 }),
  );
  await expect(page.locator("[data-work]")).toHaveCount(3);
  expect(
    await page
      .locator("[data-work]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-work"))),
  ).toEqual(["today", "yesterday-late", "yesterday-early"]);
});

test("proactive care retries a failed list request and shows an actionable empty state", async ({
  page,
}) => {
  let fail = true;
  await page.route("**/v1/care-work", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({ json: { work: [] } }),
  );
  await page.locator("#home-action-menu-trigger").click();
  await page.locator("#view-care-work").click();
  await expect(page.locator("care-work-view [role=alert]")).toHaveText(
    t("care.loadError"),
  );
  fail = false;
  await page.locator("[data-retry]").click();
  await expect(page.locator("[data-empty]")).toHaveText(t("care.empty"));
  await choose(page, "called_hauler");
  await expect(page.locator("[data-save]")).toBeEnabled();
});

test("proactive care preserves read-only notes when photos expire and recovers a failed detail load", async ({
  page,
}) => {
  const work = {
    workId: "expired-photo-log",
    kind: "cleaned_graffiti",
    note: "Cleaned the west wall.\nUsed a soft brush.",
    createdAt: "2026-09-01T18:00:00Z",
    photos: [{ photoId: "expired", expiresAt: 1 }],
  };
  let fail = true;
  let mediaRequests = 0;
  await page.route("**/v1/care-work", (route) =>
    route.fulfill({ json: { work: [work] } }),
  );
  await page.route("**/v1/care-work/expired-photo-log", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: "unavailable" } })
      : route.fulfill({ json: { work } }),
  );
  await page.route("**/v1/care-work/*/photos/*/media", (route) => {
    mediaRequests++;
    return route.fulfill({ status: 410, json: { error: "expired" } });
  });
  await openLogs(page);
  await page.locator('[data-work="expired-photo-log"]').click();
  await expect(page.locator("care-work-view [role=alert]")).toHaveText(
    t("care.loadError"),
  );
  fail = false;
  await page.locator("[data-retry]").click();
  await expect(page.locator("care-work-view h1")).toHaveText(
    t("care.kind.cleanedGraffiti"),
  );
  await expect(page.locator(".care-notes p")).toHaveText(work.note);
  await expect(page.locator(".care-photo-unavailable")).toHaveText(
    t("care.photo.expired"),
  );
  await expect(
    page.locator(
      ".care-detail-photos img, [data-edit], [data-delete], #care-note",
    ),
  ).toHaveCount(0);
  expect(mediaRequests).toBe(0);
});

/** Expire only this test's unique work ID in the dedicated local test table.
 * @param {string} workId
 */
async function expireCareReservations(workId) {
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, ScanCommand, PutCommand } = await import(
    "@aws-sdk/lib-dynamodb"
  );
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({
      endpoint: E2E_URLS.ddb,
      region: "us-east-1",
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    }),
  );
  try {
    /** @type {Record<string, any> | undefined} */
    let cursor;
    let expired = 0;
    do {
      const result = await client.send(
        new ScanCommand({
          TableName: "gnp-local-e2e",
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
          FilterExpression: "begins_with(sk, :uploads) OR sk = :budget",
          ExpressionAttributeValues: {
            ":uploads": `CARE_UPLOAD#${workId}#`,
            ":budget": `CARE_QUOTA#${workId}`,
          },
        }),
      );
      for (const item of result.Items || []) {
        item.expiresAt = Math.floor(Date.now() / 1000) - 60;
        if (item.reservations) {
          for (const reservation of Object.values(item.reservations))
            reservation.expiresAt = item.expiresAt;
        } else expired++;
        await client.send(
          new PutCommand({ TableName: "gnp-local-e2e", Item: item }),
        );
      }
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return expired;
  } finally {
    client.destroy();
  }
}

test("proactive care reuses a photo UUID after six lost presign responses", async ({
  page,
}) => {
  await openLogs(page);
  await choose(page, "offered_help");
  await page.locator("#care-photo-input").setInputFiles(PHOTO_CLEAR);
  const ids = new Set();
  let dropped = 0;
  await page.route("**/photos:presign", async (route) => {
    ids.add(route.request().postDataJSON().photoId);
    if (dropped++ < 6) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      return route.abort("failed");
    }
    return route.fallback();
  });
  for (let i = 0; i < 6; i++) {
    await page.locator(i === 0 ? "[data-save]" : "[data-retry-work]").click();
    await expect(page.locator("[data-retry-work]")).toBeVisible();
  }
  const work = await save(page, true);
  expect(work.photoCount).toBe(1);
  expect(ids.size).toBe(1);
  expect([...ids][0]).toMatch(/^[0-9a-f-]{36}$/);
});

test("proactive care replaces five expired uploads without waiting for quota TTL deletion", async ({
  page,
}) => {
  await openLogs(page);
  await choose(page, "power_washed");
  await page
    .locator("#care-photo-input")
    .setInputFiles(Array(5).fill(PHOTO_CLEAR));
  let expired = false;
  /** @type {Record<string, any>[]} */
  const submissions = [];
  await page.route("**/v1/care-work", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    submissions.push(body);
    if (!expired) {
      expired = true;
      expect(await expireCareReservations(body.workId)).toBe(5);
    }
    return route.fallback();
  });
  const saved = page.waitForResponse(
    (res) =>
      res.url().endsWith("/v1/care-work") &&
      res.request().method() === "POST" &&
      res.ok(),
  );
  await page.locator("[data-save]").click();
  await expect(page).toHaveURL(/\/care-work$/, { timeout: 30000 });
  const { work } = await (await saved).json();
  await expect(page.locator(`[data-work="${work.workId}"]`)).toBeVisible();
  const last = submissions[submissions.length - 1];
  expect(last.photoIds).toHaveLength(5);
  expect(last.workId).toBe(submissions[0].workId);
  expect(
    last.photoIds.every(
      (/** @type {string} */ id) => !submissions[0].photoIds.includes(id),
    ),
  ).toBe(true);
  await page.locator(`[data-work="${last.workId}"]`).click();
  await expect(page.locator(".care-detail-photos img")).toHaveCount(5);
});

test("proactive care replays an uncertain saved payload even after its reservation expires", async ({
  page,
}) => {
  await openLogs(page);
  await choose(page, "called_hauler");
  await page.locator("#care-photo-input").setInputFiles(PHOTO_CLEAR);
  /** @type {Record<string, any>[]} */
  const submissions = [];
  await page.route("**/v1/care-work", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    submissions.push(body);
    if (submissions.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      expect(await expireCareReservations(body.workId)).toBe(1);
      return route.abort("failed");
    }
    return route.fallback();
  });
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-retry-work]")).toBeVisible();
  await expect(page.locator("[data-edit-work]")).toHaveCount(0);
  await save(page, true);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
});

test("proactive care renews an expired reservation after an interrupted PUT", async ({
  page,
}) => {
  await openLogs(page);
  await choose(page, "offered_help");
  await page.locator("#care-photo-input").setInputFiles(PHOTO_CLEAR);
  let workId = "";
  const ids = new Set();
  await page.route("**/photos:presign", (route) => {
    workId = route.request().url().split("/").at(-2) || "";
    ids.add(route.request().postDataJSON().photoId);
    return route.fallback();
  });
  let interrupt = true;
  await page.route("**/care-work/**", (route) => {
    if (route.request().method() === "PUT" && interrupt)
      return route.abort("failed");
    return route.fallback();
  });
  await page.locator("[data-save]").click();
  await expect(page.locator("[data-retry-work]")).toBeVisible();
  expect(await expireCareReservations(workId)).toBe(1);
  interrupt = false;
  const work = await save(page, true);
  expect(work.photoCount).toBe(1);
  expect(ids.size).toBe(2);
});

test("care submission returns immediately and recovers photos after reload", async ({
  page,
}) => {
  await openLogs(page);
  await choose(page, "power_washed");
  await page.locator("#care-photo-input").setInputFiles(PHOTO_CLEAR);
  /** @type {() => void} */
  let release = () => {};
  const hold = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route("**/photos:presign", async (route) => {
    await hold;
    await route.fallback().catch(() => {});
  });
  await page.locator("[data-save]").click();
  await expect(page).toHaveURL(/\/care-work$/);
  await expect(page.locator(".care-days [role=status]")).toHaveText(
    t("care.saving"),
  );
  await page.reload();
  await expect(page.locator(".care-days [role=status]")).toHaveText(
    t("care.saving"),
  );
  const saved = page.waitForResponse(
    (res) =>
      res.url().endsWith("/v1/care-work") &&
      res.request().method() === "POST" &&
      res.ok(),
  );
  release();
  const { work } = await (await saved).json();
  const row = page.locator(`[data-work="${work.workId}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".care-detail-photos img")).toHaveCount(1);
});

test("failed care screen download provides reload recovery", async ({
  page,
}) => {
  await page.route("**/components/care-work-view.js*", (route) =>
    route.abort("failed"),
  );
  await page.locator("#home-action-menu-trigger").click();
  await page.locator("#view-care-work").click();
  await expect(page.locator("#view [role=alert]")).toHaveText(
    t("route.loadError"),
  );
  await page.unroute("**/components/care-work-view.js*");
  await page.locator("[data-route-reload]").click();
  await expect(page.locator("care-work-view h1")).toHaveText(t("care.title"));
});
