import { test, expect } from "@playwright/test";

// These tests need only Vite and a real browser's IndexedDB, not API fixtures.
test.beforeEach(async ({ page }) => {
  await page.route("**/care-storage-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Storage test</title>",
    }),
  );
  await page.goto("/care-storage-test");
});

test("reset cannot resurrect care photos, including same-device rebind", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/db.js";
    const db = await import(/* @vite-ignore */ path);
    const binding = await db.setSite("Test", {
      siteId: "site",
      deviceId: "device",
    });
    const record = {
      siteId: "site",
      deviceId: "device",
      workId: "work",
      status: "pending",
      files: [{ file: new window.Blob(["private photo"]) }],
    };
    const reset = db.resetLocalAppState();
    const lateWrite = db.saveCareSubmission(record, "insert", binding).then(
      () => "accepted",
      () => "rejected",
    );
    await reset;
    const afterReset = await lateWrite;
    await db.setSite("Test", { siteId: "site", deviceId: "device" });
    const afterRebind = await db
      .saveCareSubmission(record, "insert", binding)
      .then(
        () => "accepted",
        () => "rejected",
      );
    const records = await db.listCareSubmissions("site");
    return { afterReset, afterRebind, count: records.length };
  });
  expect(result).toEqual({
    afterReset: "rejected",
    afterRebind: "rejected",
    count: 0,
  });
});

test("reset removes an earlier insert and stale worker updates", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/db.js";
    const db = await import(/* @vite-ignore */ path);
    const binding = await db.setSite("Test", {
      siteId: "site",
      deviceId: "device",
    });
    const record = {
      siteId: "site",
      deviceId: "device",
      workId: "work",
      files: [],
    };
    await db.saveCareSubmission(record, "insert", binding);
    await db.resetLocalAppState();
    await db.setSite("Test", { siteId: "site", deviceId: "device" });
    const update = await db.saveCareSubmission(record, "update").then(
      () => "accepted",
      () => "rejected",
    );
    return { update, count: (await db.listCareSubmissions("site")).length };
  });
  expect(result).toEqual({ update: "rejected", count: 0 });
});

test("atomic revisions reject competing claims and stale edits, preserving valid edits", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/db.js";
    const db = await import(/* @vite-ignore */ path);
    const binding = await db.setSite("Test", {
      siteId: "site",
      deviceId: "device",
    });
    const record = {
      siteId: "site",
      deviceId: "device",
      workId: "work",
      status: "failed",
      editable: true,
      files: [],
    };
    await db.saveCareSubmission(record, "insert", binding);
    const stale = window.structuredClone(record);
    const edited = { ...record, status: "pending", note: "corrected" };
    await db.saveCareSubmission(edited, "edit", binding);
    const staleWrite = await db.saveCareSubmission(stale, "update").then(
      () => "accepted",
      () => "rejected",
    );
    const staleEdit = await db.saveCareSubmission(stale, "edit", binding).then(
      () => "accepted",
      () => "rejected",
    );
    const a = window.structuredClone(edited),
      b = window.structuredClone(edited);
    const writes = await Promise.allSettled([
      db.saveCareSubmission(a, "update"),
      db.saveCareSubmission(b, "update"),
    ]);
    return {
      staleWrite,
      staleEdit,
      winners: writes.filter((r) => r.status === "fulfilled").length,
      note: (await db.listCareSubmissions("site"))[0].note,
    };
  });
  expect(result).toEqual({
    staleWrite: "rejected",
    staleEdit: "rejected",
    winners: 1,
    note: "corrected",
  });
});

test("token refresh permits insertion, but a site switch does not", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/db.js";
    const db = await import(/* @vite-ignore */ path);
    const binding = await db.setSite("Test", {
      siteId: "site",
      deviceId: "device",
    });
    const record = {
      siteId: "site",
      deviceId: "device",
      workId: "work",
      files: [],
    };
    await db.updateSiteSession(
      {
        deviceId: "device",
        token: "new",
        refreshToken: "new",
        expiresIn: 3600,
        tokenGeneration: 2,
      },
      "site",
    );
    await db.saveCareSubmission(record, "insert", binding);
    await db.setSite("Other", { siteId: "other", deviceId: "device" });
    const switched = await db
      .saveCareSubmission(
        { ...record, workId: "other-work" },
        "insert",
        binding,
      )
      .then(
        () => "accepted",
        () => "rejected",
      );
    return { switched, count: (await db.listCareSubmissions("site")).length };
  });
  expect(result).toEqual({ switched: "rejected", count: 1 });
});
