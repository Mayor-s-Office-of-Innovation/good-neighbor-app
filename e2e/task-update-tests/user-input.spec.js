import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/__input_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main></main><script type="module" src="/src/main.js"></script></body></html>',
    }),
  );
  await page.goto("/__input_test");
  await page.evaluate(() => window.customElements.whenDefined("app-root"));
});

test("single issue shows pending startup and recovers without a refresh", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const { setSite } = await load("/src/db.js");
    await setSite("Synthetic site", { siteId: "input-test" });
    await load("/src/components/problem-report.js");
    const Component = /** @type {any} */ (
      window.customElements.get("problem-report")
    );
    const initialize = Component.prototype._initialize;
    Component.prototype._initialize = function () {
      Component.prototype._initialize = initialize;
      return new Promise((_, reject) => {
        /** @type {any} */ (window).rejectStartup = () =>
          reject(new Error("Synthetic storage failure"));
      });
    };
    document
      .querySelector("main")
      ?.append(document.createElement("problem-report"));
  });
  await expect(page.locator('problem-report [role="status"]')).toBeVisible();
  await page.evaluate(() => {
    const reports = /** @type {Promise<unknown>[]} */ ([]);
    /** @type {any} */ (window).startupReports = reports;
    window.navigator.sendBeacon = (_url, data) => {
      if (data instanceof window.Blob)
        reports.push(data.text().then(JSON.parse));
      return true;
    };
    /** @type {any} */ (window).rejectStartup();
  });
  await expect(page.locator('problem-report [role="alert"]')).toBeVisible();
  expect(
    await page.evaluate(() =>
      Promise.all(/** @type {any} */ (window).startupReports),
    ),
  ).toEqual([
    expect.objectContaining({
      type: "Error",
      message: "Synthetic storage failure",
    }),
  ]);
  await page.locator("[data-load-retry]").click();
  await expect(page.locator("#add-photo")).toBeVisible();
  await expect(page.locator("#describe-instead")).toBeVisible();
});

for (const kind of ["care", "native", "dialog"]) {
  test(`keeps ${kind} text entry above an overlay keyboard`, async ({
    page,
  }) => {
    await page.evaluate(async (kind) => {
      const load = (/** @type {string} */ path) => import(path);
      const Root = /** @type {any} */ (window.customElements.get("app-root"));
      const root = new Root();
      // Install the real shell's shared listeners without starting authentication.
      const viewport = new window.EventTarget();
      Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      root._startKeyboardViewportSync();
      const main = document.querySelector("main");
      if (!main) throw new Error("Missing main");
      if (kind === "care") {
        await load("/src/components/care-work-view.js");
        const { setSite } = await load("/src/db.js");
        await setSite("Synthetic site", { siteId: "input-test" });
        window.history.replaceState({}, "", "/care-work/new/other");
        main.append(document.createElement("care-work-view"));
      } else {
        main.innerHTML = `<${kind === "dialog" ? "dialog open" : "section"} style="height:700px;overflow:auto"><div style="height:420px"></div><textarea aria-label="Example" style="height:120px"></textarea><div style="height:400px"></div></${kind === "dialog" ? "dialog" : "section"}>`;
        if (kind === "dialog") {
          const dialog = main.querySelector("dialog");
          if (!dialog) throw new Error("Missing dialog");
          dialog.close();
          dialog.showModal();
        }
      }
      /** @type {any} */ (window).closeKeyboard = () => {
        Object.assign(viewport, { height: window.innerHeight });
        viewport.dispatchEvent(new window.Event("resize"));
      };
      /** @type {any} */ (window).shrinkKeyboard = () => {
        Object.assign(viewport, { height: 320 });
        viewport.dispatchEvent(new window.Event("resize"));
      };
    }, kind);
    const field = page.locator(
      kind === "care" ? "#care-note textarea" : "textarea",
    );
    await field.fill("Typing a visible note");
    await page.evaluate(() => /** @type {any} */ (window).shrinkKeyboard());
    await expect
      .poll(async () => {
        const box = await field.boundingBox();
        return !!box && box.y >= 15 && box.y + box.height <= 305;
      })
      .toBe(true);
    await field.press("End");
    await field.pressSequentially(" and more text");
    await expect(field).toHaveValue("Typing a visible note and more text");
    const box = await field.boundingBox();
    expect(box && box.y >= 15 && box.y + box.height <= 305).toBe(true);
    await field.blur();
    await page.evaluate(() => /** @type {any} */ (window).closeKeyboard());
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-keyboard-open",
    );
  });
}

test("single issue reopens a closed database and preserves its draft", async ({
  page,
}) => {
  await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const db = await load("/src/db.js");
    const prototype = window.IDBDatabase.prototype;
    const transaction = prototype.transaction;
    /** @type {IDBDatabase | undefined} */
    let connection;
    prototype.transaction = function (...args) {
      connection = this;
      return transaction.apply(this, args);
    };
    await db.setSite("Synthetic site", { siteId: "input-test" });
    await db.saveDraft({
      id: "preserved-draft",
      siteId: "input-test",
      flowType: "single-problem",
      captures: [],
    });
    prototype.transaction = transaction;
    if (!connection) throw new Error("Missing database connection");
    connection.close();
    await load("/src/components/problem-report.js");
    document
      .querySelector("main")
      ?.append(document.createElement("problem-report"));
  });
  await expect(page.locator("#add-photo")).toBeVisible();
  await expect(page.locator("#describe-instead")).toBeVisible();
  expect(
    await page.evaluate(async () => {
      const load = (/** @type {string} */ path) => import(path);
      const db = await load("/src/db.js");
      const session = await load("/src/state/check-session.js");
      return {
        saved: (await db.getDraft("single-problem"))?.id,
        active: session.getCurrentCheck()?.id,
      };
    }),
  ).toEqual({ saved: "preserved-draft", active: "preserved-draft" });
});

test("database recovery stops after one retry and the next call can recover", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const db = await load("/src/db.js");
    await db.setSite("Synthetic site", { siteId: "input-test" });
    const prototype = window.IDBDatabase.prototype;
    const transaction = prototype.transaction;
    let attempts = 0;
    prototype.transaction = function (...args) {
      attempts++;
      this.close();
      return transaction.apply(this, args);
    };
    let error;
    try {
      await db.getSite();
    } catch (caught) {
      error =
        caught instanceof window.DOMException ? caught.name : "unexpected";
    }
    prototype.transaction = transaction;
    return { attempts, error, siteId: (await db.getSite())?.siteId };
  });
  expect(result).toEqual({
    attempts: 2,
    error: "InvalidStateError",
    siteId: "input-test",
  });
});

test("database recovery never replays an aborted write transaction", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const db = await load("/src/db.js");
    await db.setSite("Synthetic site", { siteId: "input-test" });
    const prototype = window.IDBDatabase.prototype;
    const transaction = prototype.transaction;
    let writes = 0;
    prototype.transaction = function (...args) {
      const tx = transaction.apply(this, args);
      if (args[1] === "readwrite") {
        writes++;
        tx.abort();
      }
      return tx;
    };
    let rejected = false;
    try {
      await db.saveDraft({
        id: "aborted",
        siteId: "input-test",
        flowType: "single-problem",
      });
    } catch {
      rejected = true;
    }
    prototype.transaction = transaction;
    return {
      writes,
      rejected,
      draft: (await db.getDraft("single-problem")) ?? null,
    };
  });
  expect(result).toEqual({ writes: 1, rejected: true, draft: null });
});

test("a failed database open does not poison later attempts", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const db = await load("/src/db.js?open-failure-test");
    const factory = window.indexedDB;
    const open = factory.open;
    factory.open = function () {
      throw new window.DOMException("Synthetic open failure", "UnknownError");
    };
    let rejected = false;
    try {
      await db.getSite();
    } catch {
      rejected = true;
    }
    factory.open = open;
    await db.setSite("Synthetic site", { siteId: "recovered-open" });
    return { rejected, siteId: (await db.getSite())?.siteId };
  });
  expect(result).toEqual({ rejected: true, siteId: "recovered-open" });
});

test("keyboard reveal preserves visibility inside nested scrollers", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const load = (/** @type {string} */ path) => import(path);
    const { revealEditable } = await load("/src/services/keyboard-viewport.js");
    document.body.innerHTML =
      '<div style="height:500px"></div><section style="height:200px;overflow:auto"><div style="height:50px"></div><textarea style="height:50px">Example</textarea><div style="height:800px"></div></section><div style="height:1000px"></div>';
    const field = document.querySelector("textarea");
    if (!field?.parentElement) throw new Error("Missing field");
    revealEditable(field, { height: 320, offsetTop: 0, scale: 1 });
    const a = field.getBoundingClientRect();
    const b = field.parentElement.getBoundingClientRect();
    return {
      inViewport: a.top >= 16 && a.bottom <= 304,
      inContainer: a.top >= b.top && a.bottom <= b.bottom,
    };
  });
  expect(result).toEqual({ inViewport: true, inContainer: true });
});

for (const name of ["perimeter-check", "problem-report"]) {
  test(`${name}: opening results aligns its dropdown with the viewport top`, async ({
    page,
  }) => {
    await page.evaluate(async (name) => {
      const load = (/** @type {string} */ path) => import(path);
      const { setSite } = await load("/src/db.js");
      await setSite("Synthetic site", { siteId: "input-test" });
      await load(`/src/components/${name}.js`);
      document.querySelector("main")?.append(document.createElement(name));
    }, name);
    await expect(page.locator(`${name} h1`)).toBeVisible();
    await page.evaluate(async () => {
      const path = "/src/state/check-session.js";
      const { addItem, setAnalyzingOpen } = await import(path);
      addItem({ kind: "text", text: "Synthetic perimeter description" });
      setAnalyzingOpen(false);
      // Leave room to align the footer even when the fixture has little evidence.
      const filler = document.createElement("div");
      filler.style.height = "1500px";
      document.querySelector("main")?.append(filler);
    });
    const dropdown = page.locator("#toggle-analyzing");
    await expect(dropdown).toHaveAttribute("aria-expanded", "false");
    await dropdown.click();
    await expect(dropdown).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(async () => (await dropdown.boundingBox())?.y)
      .toBeLessThan(2);
    await expect(dropdown).toBeFocused();
  });
}
