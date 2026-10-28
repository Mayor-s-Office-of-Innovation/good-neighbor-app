// @ts-check
import { test, expect } from "../helpers/harness.js";
import { test as bare } from "@playwright/test";
import { addPhoto, startCheck } from "../helpers/app.js";
import { setAnalyzerFixture } from "../helpers/analyzer-control.js";
import { t } from "../helpers/i18n.js";
import { PHOTO_CLEAR } from "../helpers/fixtures.js";

/*
  Perimeter checks with no connection. The app must already be open: the dev
  server has no service worker, so these cover the in-app queue
  (services/check-submissions.js), not offline launch.

  - a photo taken offline waits on the device and still unlocks Finish;
  - home shows its last saved lists and Start check while offline;
  - two checks finished offline both reach the backend once back online;
  - the local store keeps every finished check, not just the newest.
*/

/** @param {import("@playwright/test").Page} page */
const currentCheckId = (page) =>
  page.evaluate(async () => {
    const path = "/src/state/check-session.js";
    const session = await import(/* @vite-ignore */ path);
    return session.getCurrentCheck()?.id;
  });

/** @param {import("@playwright/test").Page} page */
const submittedCheckIds = (page) =>
  page.evaluate(async () => {
    const apiPath = "/src/services/api.js";
    const adapterPath = "/src/domain/check-adapter.js";
    const api = await import(/* @vite-ignore */ apiPath);
    const { adaptCheckHeader } = await import(/* @vite-ignore */ adapterPath);
    const { checks } = await api.listChecks({ limit: 30 });
    return (checks || [])
      .map(adaptCheckHeader)
      .filter((/** @type {any} */ check) => check.status === "submitted")
      .map((/** @type {any} */ check) => check.id);
  });

/**
 * Offline, take one photo and finish. Returns the check id.
 * @param {import("@playwright/test").Page} page
 */
async function finishOfflineCheck(page) {
  await startCheck(page);
  const checkId = await currentCheckId(page);
  await addPhoto(page, PHOTO_CLEAR);
  await expect(page.locator(".analysis-card--waiting")).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(page.locator("#done-check")).toBeEnabled();
  await page.locator("#done-check").click();
  await expect(page.locator("#start-check")).toBeVisible({ timeout: 30_000 });
  return checkId;
}

test.describe("offline checks", () => {
  test("a photo taken offline waits on the device and unlocks Finish", async ({
    page,
  }) => {
    await setAnalyzerFixture("excellent");
    await startCheck(page);
    await page.context().setOffline(true);

    await addPhoto(page, PHOTO_CLEAR);
    await expect(page.locator(".shot img")).toHaveCount(1, { timeout: 30_000 });
    const waiting = page.locator(".analysis-card--waiting");
    await expect(waiting).toHaveCount(1, { timeout: 30_000 });
    await expect(waiting).toContainText(t("card.waiting.title"));
    await expect(page.locator(".analysis-card--failed")).toHaveCount(0);
    await expect(page.locator("#done-check")).toBeEnabled();
  });

  test("home shows its saved lists and Start check while offline", async ({
    page,
  }) => {
    await page.context().setOffline(true);
    // Re-run home's load the way returning to it does.
    await page.evaluate(() => {
      const home = /** @type {any} */ (document.querySelector("today-view"));
      home.connectedCallback();
    });
    await expect(page.locator("#start-check")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("#retry")).toHaveCount(0);
  });

  test("two checks finished offline both reach the backend once back online", async ({
    page,
  }) => {
    await setAnalyzerFixture("excellent");
    // The check screen is a lazy chunk. Deployed builds precache it (the
    // service worker); the dev server has none, so load it while online.
    await page.evaluate(() => {
      const path = "/src/components/perimeter-check.js";
      return import(/* @vite-ignore */ path);
    });
    await page.context().setOffline(true);

    const first = await finishOfflineCheck(page);
    const second = await finishOfflineCheck(page);
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);

    await page.context().setOffline(false);
    await expect
      .poll(() => submittedCheckIds(page), { timeout: 120_000 })
      .toEqual(expect.arrayContaining([first, second]));
  });
  test("logout warns about a check that hasn't uploaded", async ({ page }) => {
    await setAnalyzerFixture("excellent");
    await page.evaluate(() => {
      const path = "/src/components/perimeter-check.js";
      return import(/* @vite-ignore */ path);
    });
    await page.context().setOffline(true);
    await finishOfflineCheck(page);

    await page.locator("#home-settings").click();
    await page.locator("#settings-logout").click();
    const unsent = page.locator("#logout-dialog #logout-unsent");
    await expect(unsent).toBeVisible();
    await expect(unsent).toContainText(
      t("today.logout.unsentChecks", { count: 1 }),
    );
    // Back out: the check must stay on the device.
    await page.locator("#logout-dialog .logout-dialog__cancel").click();
    await expect(page.locator("#logout-dialog")).not.toBeVisible();
  });
});

// Storage only: needs Vite and IndexedDB, not the API or a bound site flow.
bare.describe("offline checks: local storage", () => {
  bare.beforeEach(async ({ page }) => {
    await page.route("**/offline-checks-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Offline checks test</title>",
      }),
    );
    await page.goto("/offline-checks-test");
  });

  bare(
    "finishing a second check keeps the first in the store",
    async ({ page }) => {
      const result = await page.evaluate(async () => {
        const dbPath = "/src/db.js";
        const sessionPath = "/src/state/check-session.js";
        const db = await import(/* @vite-ignore */ dbPath);
        const session = await import(/* @vite-ignore */ sessionPath);
        await db.setSite("Test", { siteId: "site", deviceId: "device" });

        const finish = async () => {
          const check = session.startCheck("site");
          session.addItem({ kind: "text", text: "Litter by the gate" });
          session.markCaptureComplete({ checkId: check.id });
          // persist() is fire-and-forget; let IndexedDB settle.
          await new Promise((resolve) => setTimeout(resolve, 200));
          return check.id;
        };

        const first = await finish();
        const second = await finish();
        const stored = (await db.listFinishedChecks("site")).map(
          (/** @type {any} */ check) => check.id,
        );
        return { first, second, stored };
      });

      expect(result.stored).toEqual([result.first, result.second]);
    },
  );

  bare("moves a check saved in the old single slot", async ({ page }) => {
    const stored = await page.evaluate(async () => {
      const dbPath = "/src/db.js";
      const db = await import(/* @vite-ignore */ dbPath);
      await db.setSite("Test", { siteId: "site", deviceId: "device" });
      // The layout before the queue: one record per site under this key.
      await new Promise((resolve, reject) => {
        const open = window.indexedDB.open("conditions-reporter");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("review", "readwrite");
          tx.objectStore("review").put(
            {
              id: "legacy",
              siteId: "site",
              status: "capture-complete",
              items: [],
            },
            "site:site:current",
          );
          tx.oncomplete = () => resolve(undefined);
          tx.onerror = () => reject(tx.error);
        };
      });
      const first = (await db.listFinishedChecks("site")).map(
        (/** @type {any} */ c) => c.id,
      );
      const again = (await db.listFinishedChecks("site")).map(
        (/** @type {any} */ c) => c.id,
      );
      return { first, again };
    });
    expect(stored).toEqual({ first: ["legacy"], again: ["legacy"] });
  });
  bare("counts unsent checks and care logs on every site", async ({ page }) => {
    const counts = await page.evaluate(async () => {
      const dbPath = "/src/db.js";
      const db = await import(/* @vite-ignore */ dbPath);
      await db.setSite("Test", { siteId: "site", deviceId: "device" });
      const empty = await db.countUnsentWork();
      await new Promise((resolve, reject) => {
        const open = window.indexedDB.open("conditions-reporter");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction("review", "readwrite");
          const store = tx.objectStore("review");
          const check = (/** @type {string} */ id, extra = {}) => ({
            id,
            status: "capture-complete",
            items: [],
            ...extra,
          });
          store.put(check("a", { siteId: "site" }), "check:site:a");
          store.put(check("b", { siteId: "other" }), "check:other:b");
          store.put(
            check("sent", { siteId: "site", scorecardDone: true }),
            "check:site:sent",
          );
          store.put(check("old", { siteId: "site" }), "site:site:current");
          store.put(
            { careSubmission: true, siteId: "site", status: "pending" },
            "care:site:w1",
          );
          store.put(
            { careSubmission: true, siteId: "other", status: "failed" },
            "care:other:w2",
          );
          store.put(
            { careSubmission: true, siteId: "site", status: "saved" },
            "care:site:w3",
          );
          store.put({ siteId: "site", items: [] }, "home:site");
          tx.oncomplete = () => resolve(undefined);
          tx.onerror = () => reject(tx.error);
        };
      });
      return { empty, filled: await db.countUnsentWork() };
    });
    expect(counts).toEqual({
      empty: { checks: 0, careLogs: 0 },
      filled: { checks: 3, careLogs: 2 },
    });
  });
});
