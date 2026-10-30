import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "@playwright/test";

// A browser-native IndexedDB test without AWS, the API, or app startup effects.
test("upload identities survive reload, serialize across tabs, rotate and isolate bindings", async () => {
  const source = await readFile(
    new URL("../frontend/src/db.js", import.meta.url),
    "utf8",
  );
  const server = createServer((req, res) => {
    res.setHeader(
      "Content-Type",
      req.url === "/db.js" ? "text/javascript" : "text/html",
    );
    res.end(
      req.url === "/db.js"
        ? source
        : "<!doctype html><title>Storage test</title>",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    await page.evaluate(async () => {
      const db = await import("/db.js");
      await db.setSite("Synthetic site", {
        siteId: "site-test",
        deviceId: "actor-test",
      });
    });
    const request = (tab, fingerprint = "synthetic-fingerprint", replaceId) =>
      tab.evaluate(
        async ({ fingerprint, replaceId }) => {
          const db = await import("/db.js");
          return db.getUploadRequestId("check:test", fingerprint, replaceId);
        },
        { fingerprint, replaceId },
      );
    const id = await request(page);
    await page.reload();
    assert.equal(await request(page), id);
    const other = await context.newPage();
    await other.goto(origin);
    const ids = await Promise.all([
      request(page, "new-file"),
      request(other, "new-file"),
    ]);
    assert.equal(ids[0], ids[1]);
    const rotated = await Promise.all([
      request(page, "synthetic-fingerprint", id),
      request(other, "synthetic-fingerprint", id),
    ]);
    assert.equal(rotated[0], rotated[1]);
    assert.notEqual(rotated[0], id);
    assert.notEqual(await request(page, "changed-bytes"), rotated[0]);
    await page.evaluate(async () => {
      const db = await import("/db.js");
      await db.setSite("Other synthetic site", {
        siteId: "other-site",
        deviceId: "actor-test",
      });
    });
    assert.notEqual(await request(page), rotated[0]);
    await page.evaluate(async () => {
      const db = await import("/db.js");
      await db.setSite("Synthetic site", {
        siteId: "site-test",
        deviceId: "actor-test",
      });
    });
    assert.equal(await request(page), rotated[0]);
    assert.deepEqual(
      await page.evaluate(async () =>
        (await import("/db.js")).countUnsentWork(),
      ),
      { checks: 0, careLogs: 0 },
    );
    await page.clock.install();
    await page.clock.setFixedTime(new Date(Date.now() + 86400000));
    assert.notEqual(await request(page), rotated[0]);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
