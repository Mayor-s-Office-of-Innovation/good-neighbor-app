/* global localStorage, File, Blob, IDBObjectStore, DOMException, Event, customElements, HTMLElement, structuredClone */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route("**/__capture_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><title>Capture test</title></head><body><main id="test"></main></body></html>',
    }),
  );
  await page.goto("/__capture_test");
  await page.evaluate(async () => {
    localStorage.setItem("gnp:analytics", "off");
    localStorage.setItem("gnp:perf", "off");
    window.db = await import("/src/db.js");
    window.session = await import("/src/state/check-session.js");
    await window.db.setSite("Synthetic site", {
      siteId: "synthetic-site",
      deviceId: "synthetic-device",
      token: "synthetic-token",
    });
    window.check = window.session.startCheck("synthetic-site");
    await window.db.saveDraft(window.check);
  });
});

test("original is durable, metadata-only saves, registration releases bytes before any thumbnail", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { db, session, check } = window;
    const original = new File(
      [new Uint8Array([0, 1, 2, 255])],
      "synthetic.jpg",
      { type: "image/jpeg" },
    );
    const item = await session.addCapturedPhoto(original);
    const stored = await db.getCaptureMedia(item.media.key);
    await db.releaseCaptureOriginal(item.media.key, "unconfirmed-artifact");
    const unconfirmedRetained = !!(await db.getCaptureMedia(item.media.key))
      .original;
    const writes = [];
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      writes.push({
        store: this.name,
        bytes: JSON.stringify(value).length,
        hasInline: !!value.items?.some((i) => i.dataUrl),
      });
      return put.call(this, value, ...args);
    };
    session.updateItemAnalysis(item.id, { status: "analyzing" });
    await db.saveDraft(check);
    IDBObjectStore.prototype.put = put;
    const draft = await db.getDraft("perimeter");
    session.updateItem(item.id, {
      upload: {
        status: "uploaded",
        artifactId: "synthetic-artifact",
        contentType: original.type,
        contentLength: original.size,
      },
    });
    await db.releaseCaptureOriginal(item.media.key, "synthetic-artifact");
    const released = await db.getCaptureMedia(item.media.key);
    const tiny = new Blob(["thumbnail"], { type: "image/webp" });
    const cached = await db.cacheCaptureThumbnail(
      item.media.key,
      "synthetic-artifact",
      tiny,
    );
    const after = await db.getCaptureMedia(item.media.key);
    return {
      unconfirmedRetained,
      bytes: [...new Uint8Array(await stored.original.arrayBuffer())],
      writes,
      inline: draft.items[0].dataUrl,
      originalAfter: !!released.original,
      thumbnailAtRelease: !!released.thumbnail,
      cached,
      thumb: await after.thumbnail.text(),
    };
  });
  expect(result.unconfirmedRetained).toBe(true);
  expect(result.bytes).toEqual([0, 1, 2, 255]);
  expect(
    result.writes.every(
      (w) => w.store === "draft" && !w.hasInline && w.bytes < 2000,
    ),
  ).toBe(true);
  expect(result.inline).toBeUndefined();
  expect(result.originalAfter).toBe(false);
  expect(result.thumbnailAtRelease).toBe(false);
  expect(result.cached).toBe(true);
  expect(result.thumb).toBe("thumbnail");
});

test("offline reload preserves pending originals; deletion prevents late thumbnail resurrection", async ({
  page,
}) => {
  const key = await page.evaluate(
    async () =>
      (
        await window.session.addCapturedPhoto(
          new File(["pending original"], "synthetic.jpg", {
            type: "image/jpeg",
          }),
        )
      ).media.key,
  );
  await page.reload();
  const result = await page.evaluate(async (key) => {
    const db = await import("/src/db.js");
    const session = await import("/src/state/check-session.js");
    const check = await session.loadDraft("perimeter");
    const pending = await db.getCaptureMedia(key);
    session.removeItem(check.items[0].id);
    await db.saveDraft(check);
    const cached = await db.cacheCaptureThumbnail(
      key,
      "late-artifact",
      new Blob(["thumb"], { type: "image/webp" }),
    );
    return {
      text: await pending.original.text(),
      cached,
      exists: !!(await db.getCaptureMedia(key)),
    };
  }, key);
  expect(result).toEqual({
    text: "pending original",
    cached: false,
    exists: false,
  });
});

test("legacy draft migration removes inline images and retains exact upload bytes", async ({
  page,
}) => {
  await page.evaluate(async () => {
    window.check.items = [
      {
        id: "legacy",
        checkId: window.check.id,
        kind: "photo",
        dataUrl: "data:image/jpeg;base64,aGVsbG8=",
        analysis: { status: "waiting" },
      },
    ];
    await window.db.saveDraft(window.check);
  });
  await page.reload();
  const result = await page.evaluate(async () => {
    const db = await import("/src/db.js");
    const session = await import("/src/state/check-session.js");
    const check = await session.loadDraft("perimeter");
    const item = check.items[0];
    return {
      inline: item.dataUrl,
      savedInline: (await db.getDraft("perimeter")).items[0].dataUrl,
      text: await (await db.getCaptureMedia(item.media.key)).original.text(),
    };
  });
  expect(result).toEqual({
    inline: undefined,
    savedInline: undefined,
    text: "hello",
  });
});

test("failed admission rolls back evidence; discarded captures cannot recreate a draft", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { session, db, check } = window;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "captureMedia")
        throw new DOMException("Synthetic quota failure", "QuotaExceededError");
      return put.apply(this, args);
    };
    let failed = false;
    try {
      await session.addCapturedPhoto(
        new File(["original"], "synthetic.jpg", { type: "image/jpeg" }),
      );
    } catch {
      failed = true;
    }
    IDBObjectStore.prototype.put = put;
    await db.saveDraft(check);
    const count = (await db.getDraft("perimeter")).items.length;
    session.clearCheck();
    const item = { id: "late", media: { key: "late" }, kind: "photo" };
    check.items.push(item);
    const accepted = await db.saveCapturePhoto(check, item, new Blob(["late"]));
    return {
      failed,
      count,
      accepted,
      exists: !!(await db.getCaptureMedia("late")),
    };
  });
  expect(result).toEqual({
    failed: true,
    count: 0,
    accepted: false,
    exists: false,
  });
});

test("grid keeps images and focus across status updates and inserting another photo", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { renderCaptureGrid } = await import(
      "/src/components/capture-grid.js"
    );
    const grid = document.querySelector("#test");
    const items = [1, 2, 3].map((n) => ({
      id: String(n),
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
      analysis: { status: "queued" },
    }));
    renderCaptureGrid(grid, items, null);
    const image = grid
      .querySelector('[data-del="2"]')
      .parentElement.querySelector("img");
    const button = grid.querySelector('[data-del="2"]');
    button.focus();
    items[0].analysis.status = "analyzed";
    renderCaptureGrid(grid, items, null);
    items.push({
      id: "4",
      kind: "photo",
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
      analysis: { status: "queued" },
    });
    renderCaptureGrid(grid, items, null);
    return {
      same:
        image ===
        grid.querySelector('[data-del="2"]').parentElement.querySelector("img"),
      focused: document.activeElement === button,
      order: [...grid.querySelectorAll("[data-del]")].map((n) => n.dataset.del),
    };
  });
  expect(result).toEqual({
    same: true,
    focused: true,
    order: ["4", "3", "2", "1"],
  });
});

test("missing thumbnail never downloads the original; thumbnails cache and full originals open only on demand", async ({
  page,
}) => {
  let fullRequests = 0,
    thumbRequests = 0,
    ready = false;
  await page.route("**/v1/checks/**/artifacts/**/media", (route) =>
    route.fulfill({
      json: {
        downloadUrl: "http://127.0.0.1:5179/synthetic-original",
        ...(ready
          ? { thumbnailUrl: "http://127.0.0.1:5179/synthetic-thumbnail" }
          : {}),
        expiresIn: 300,
      },
    }),
  );
  await page.route("**/synthetic-original", (route) => {
    fullRequests++;
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.route("**/synthetic-thumbnail", (route) => {
    thumbRequests++;
    return route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.evaluate(async () => {
    const { db, session } = window;
    const item = await session.addCapturedPhoto(
      new File(["original"], "synthetic.jpg", { type: "image/jpeg" }),
    );
    session.updateItem(item.id, {
      upload: { status: "uploaded", artifactId: "synthetic-artifact" },
    });
    await db.releaseCaptureOriginal(item.media.key, "synthetic-artifact");
    const { capturePhoto } = await import(
      "/src/components/capture-photo.templates.js"
    );
    const { t } = await import("/src/i18n/i18n.js");
    document.querySelector("#test").innerHTML =
      '<button data-photo-lightbox style="width:100px;height:100px">' +
      capturePhoto(item, t("lightbox.image.alt")) +
      "</button>";
    await import("/src/components/capture-photo.js");
    window.item = item;
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector("capture-photo")._attempts),
    )
    .toBeGreaterThan(0);
  expect(fullRequests).toBe(0);
  expect(thumbRequests).toBe(0);
  ready = true;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("capture-photo img")).toHaveAttribute(
    "src",
    /^blob:/,
  );
  expect(fullRequests).toBe(0);
  expect(thumbRequests).toBe(1);
  await page.evaluate(async () => {
    const { openPhotoLightbox } = await import(
      "/src/components/photo-lightbox.js"
    );
    const host = document.querySelector("#test");
    await openPhotoLightbox(host, host.querySelector("button"));
  });
  await expect.poll(() => fullRequests).toBe(1);
  await page.evaluate(() => document.querySelector("photo-lightbox").close());
  await expect(page.locator("photo-lightbox img")).not.toHaveAttribute(
    "src",
    /./,
  );
});

test("pipeline retains unacknowledged uploads and releases confirmed originals while analysis is pending", async ({
  page,
}) => {
  let registerSucceeds = false;
  const puts = [];
  await page.route("**/v1/checks", (route) => route.fulfill({ json: {} }));
  await page.route("**/v1/checks/*/artifacts:presign", (route) =>
    route.fulfill({
      json: {
        artifactId: "pipeline-artifact",
        s3Key: "synthetic-key",
        uploadUrl: "http://127.0.0.1:5179/synthetic-put",
      },
    }),
  );
  await page.route("**/synthetic-put", (route) => {
    puts.push(route.request().postDataBuffer());
    return route.fulfill({ status: 200, body: "" });
  });
  await page.route("**/v1/checks/*/artifacts", (route) =>
    route.fulfill({
      status: registerSucceeds ? 200 : 500,
      json: registerSucceeds
        ? {}
        : { error: "Synthetic registration interruption" },
    }),
  );
  await page.route("**/v1/checks/*", (route) =>
    route.fulfill({ json: { check: {}, artifacts: [], analyses: [] } }),
  );
  await page.evaluate(async () => {
    // WebKit's request inspector omits Blob bodies. Observe the actual fetch
    // input as well, without replacing the request or skipping network checks.
    const fetch = window.fetch.bind(window);
    window.uploadBytes = [];
    window.fetch = async (input, init) => {
      if (
        String(input).endsWith("/synthetic-put") &&
        init?.body instanceof Blob
      )
        window.uploadBytes.push([
          ...new Uint8Array(await init.body.arrayBuffer()),
        ]);
      return fetch(input, init);
    };
    const { session } = window;
    window.item = await session.addCapturedPhoto(
      new File([new Uint8Array([0, 17, 128, 255])], "synthetic.jpg", {
        type: "image/jpeg",
      }),
    );
    const pipeline = await import("/src/services/photo-analysis.js");
    window.pipeline = pipeline;
    pipeline.analyzeEvidenceItem(window.item.id);
  });
  await expect
    .poll(() => page.evaluate(() => window.item.analysis.status))
    .toBe("failed");
  expect(
    await page.evaluate(
      async () =>
        !!(await window.db.getCaptureMedia(window.item.media.key)).original,
    ),
  ).toBe(true);
  registerSucceeds = true;
  await page.evaluate(() => window.pipeline.retryEvidenceItem(window.item.id));
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          !!(await window.db.getCaptureMedia(window.item.media.key)).original,
      ),
    )
    .toBe(false);
  expect(await page.evaluate(() => window.item.analysis.status)).toBe(
    "analyzing",
  );
  expect(puts.length).toBeGreaterThan(0);
  const bytes = await page.evaluate(() => window.uploadBytes);
  expect(bytes).toHaveLength(puts.length);
  for (const body of bytes) expect(body).toEqual([0, 17, 128, 255]);
  for (const body of puts.filter(Boolean))
    expect([...body]).toEqual([0, 17, 128, 255]);
});

test("finished-check and sign-out cleanup remove original and thumbnail records", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { session, db, check } = window;
    const item = await session.addCapturedPhoto(
      new File(["first"], "synthetic.jpg", { type: "image/jpeg" }),
    );
    session.markCaptureComplete();
    await db.saveFinishedCheck(check);
    session.startCheck("synthetic-site");
    await db.saveDraft(session.getCurrentCheck());
    const second = await session.addCapturedPhoto(
      new File(["second"], "synthetic.jpg", { type: "image/jpeg" }),
    );
    await session.clearSubmittedSession(check.id);
    const firstGone = !(await db.getCaptureMedia(item.media.key));
    const secondKept = !!(await db.getCaptureMedia(second.media.key)).original;
    await db.resetLocalAppState();
    return {
      firstGone,
      secondKept,
      secondGone: !(await db.getCaptureMedia(second.media.key)),
    };
  });
  expect(result).toEqual({
    firstGone: true,
    secondKept: true,
    secondGone: true,
  });
});

test("mounted capture admits camera photos durably and stays usable offline", async ({
  page,
}, testInfo) => {
  await page.route("**/v1/**", (route) => route.abort("internetdisconnected"));
  await page.evaluate(async () => {
    await import("/src/styles/tokens.css");
    await import("/src/styles/base.css");
    await import("/src/components/capture-photo.js");
    await import("/src/components/perimeter-check.js");
    document
      .querySelector("#test")
      .append(document.createElement("perimeter-check"));
  });
  await expect(page.locator("#file-input")).toHaveCount(1);
  await page.locator("#file-input").setInputFiles({
    name: "synthetic-camera.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0, 17, 128, 255]),
  });
  await expect(page.locator("#shotgrid capture-photo")).toHaveCount(1);
  await expect(page.locator("#done-check")).toBeEnabled();
  const result = await page.evaluate(async () => {
    const check = window.session.getCurrentCheck();
    const item = check.items[0];
    return {
      count: check.items.length,
      inline: !!item.dataUrl,
      stored: !!(await window.db.getCaptureMedia(item.media.key)).original,
    };
  });
  expect(result).toEqual({ count: 1, inline: false, stored: true });
  await page.locator("[data-del]").focus();
  await page.locator("#file-input").setInputFiles({
    name: "synthetic-camera-2.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0, 17, 128, 255]),
  });
  await expect(page.locator("#shotgrid capture-photo")).toHaveCount(2);
  await expect(page.locator("[data-del]").last()).toBeFocused();
  expect(
    (
      await new AxeBuilder({ page })
        .include(".view-check")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("offline-capture.png"),
  });
});

test("description updates preserve photo connections and keyboard focus", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { renderCaptureGrid } = await import(
      "/src/components/capture-grid.js"
    );
    let disconnects = 0;
    customElements.define(
      "capture-photo",
      class extends HTMLElement {
        disconnectedCallback() {
          disconnects++;
        }
      },
    );
    const grid = document.querySelector("#test");
    const photos = [1, 2, 3].map((n) => ({
      id: String(n),
      checkId: "synthetic",
      kind: "photo",
      media: { key: String(n) },
      analysis: { status: "queued" },
    }));
    const description = {
      id: "description",
      kind: "text",
      text: "Synthetic description",
      analysis: { status: "queued" },
    };
    renderCaptureGrid(grid, photos, null);
    const button = grid.querySelector('[data-del="2"]');
    button.focus();
    renderCaptureGrid(grid, photos, description);
    photos[0].analysis.status = "analyzed";
    renderCaptureGrid(grid, photos, description);
    const focusedWithDescription = document.activeElement === button;
    renderCaptureGrid(grid, photos, null);
    return {
      disconnects,
      focusedWithDescription,
      focusedAfterRemoval: document.activeElement === button,
    };
  });
  expect(result).toEqual({
    disconnects: 0,
    focusedWithDescription: true,
    focusedAfterRemoval: true,
  });
});

test("photo click waits for the lazy component to register", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { openPhotoLightbox } = await import(
      "/src/components/photo-lightbox.js"
    );
    const host = document.querySelector("#test");
    host.innerHTML =
      '<button data-photo-lightbox><capture-photo><img hidden alt="Synthetic photo"></capture-photo></button>';
    let calls = 0;
    let settled = false;
    const opening = openPhotoLightbox(
      host,
      host.querySelector("button"),
    ).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waited = !settled;
    customElements.define(
      "capture-photo",
      class extends HTMLElement {
        async original() {
          calls++;
          return {
            src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            release() {},
          };
        }
      },
    );
    await opening;
    return { waited, calls, open: host.querySelector("dialog").open };
  });
  expect(result).toEqual({ waited: true, calls: 1, open: true });
});

test("stale-tab photo admission preserves deletions and newer metadata on later saves", async ({
  page,
  context,
}) => {
  await page.evaluate(async () => {
    await window.session.addCapturedPhoto(
      new File(["old"], "old.jpg", { type: "image/jpeg" }),
    );
  });
  const other = await context.newPage();
  await other.route("**/__capture_test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body></body></html>",
    }),
  );
  await other.goto("/__capture_test");
  await other.evaluate(async () => {
    const db = await import("/src/db.js");
    const check = await db.getDraft("perimeter");
    const key = check.items[0].media.key;
    check.analyzingOpen = false;
    await db.saveDraft(check);
    check.items = [];
    await db.deleteCapturePhoto(check, key);
  });
  const result = await page.evaluate(async () => {
    const { db, session } = window;
    const photo = await session.addCapturedPhoto(
      new File(["new"], "new.jpg", { type: "image/jpeg" }),
    );
    const afterAdmission = await db.getDraft("perimeter");
    session.updateItemAnalysis(photo.id, { status: "waiting" });
    await db.saveDraft(session.getCurrentCheck());
    const later = await db.getDraft("perimeter");
    return {
      admitted: afterAdmission.items.map((i) => i.id),
      later: later.items.map((i) => i.id),
      expected: [photo.id],
      newerFlag: later.analyzingOpen,
      identity: session.getCurrentCheck().items[0] === photo,
      bytes: await (await db.getCaptureMedia(photo.media.key)).original.text(),
    };
  });
  expect(result.admitted).toEqual(result.expected);
  expect(result.later).toEqual(result.expected);
  expect(result.newerFlag).toBe(false);
  expect(result.identity).toBe(true);
  expect(result.bytes).toBe("new");
  await other.close();
});

test("stale photo removal preserves a concurrent admission", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { db, session } = window;
    const first = await session.addCapturedPhoto(
      new File(["first"], "first.jpg", { type: "image/jpeg" }),
    );
    const stale = structuredClone(await db.getDraft("perimeter"));
    const second = await session.addCapturedPhoto(
      new File(["second"], "second.jpg", { type: "image/jpeg" }),
    );
    stale.items = [];
    await db.deleteCapturePhoto(stale, first.media.key);
    await db.saveDraft(stale);
    const saved = await db.getDraft("perimeter");
    return {
      ids: saved.items.map((i) => i.id),
      expected: [second.id],
      removed: !(await db.getCaptureMedia(first.media.key)),
    };
  });
  expect(result.ids).toEqual(result.expected);
  expect(result.removed).toBe(true);
});

for (const stage of ["definition", "original"]) {
  test(`removed photo cannot open after awaiting ${stage}`, async ({
    page,
  }) => {
    const result = await page.evaluate(async (stage) => {
      const { openPhotoLightbox } = await import(
        "/src/components/photo-lightbox.js"
      );
      const host = document.querySelector("#test");
      host.innerHTML =
        '<section><button data-photo-lightbox><capture-photo><img alt="Synthetic"></capture-photo></button></section>';
      const screen = host.querySelector("section");
      const trigger = screen.querySelector("button");
      let resolveOriginal, started;
      const began = new Promise((resolve) => {
        started = resolve;
      });
      const pending = new Promise((resolve) => {
        resolveOriginal = resolve;
      });
      let calls = 0,
        released = 0;
      const define = () =>
        customElements.define(
          "capture-photo",
          class extends HTMLElement {
            original() {
              calls++;
              started();
              return pending;
            }
          },
        );
      if (stage === "original") define();
      const opening = openPhotoLightbox(host, trigger, screen);
      if (stage === "original") await began;
      trigger.remove();
      if (stage === "definition") define();
      resolveOriginal({
        src: "blob:synthetic",
        release() {
          released++;
        },
      });
      await opening;
      return { opened: !!host.querySelector("dialog"), calls, released };
    }, stage);
    expect(result).toEqual({
      opened: false,
      calls: stage === "original" ? 1 : 0,
      released: stage === "original" ? 1 : 0,
    });
  });
}

test("admission rebase retains upload progress changed while its transaction is pending", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { db, session } = window;
    const first = await session.addCapturedPhoto(
      new File(["first"], "first.jpg", { type: "image/jpeg" }),
    );
    const put = IDBObjectStore.prototype.put;
    let changed = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === "captureMedia" && !changed) {
        changed = true;
        session.updateItemAnalysis(first.id, { status: "waiting" });
      }
      return request;
    };
    try {
      await session.addCapturedPhoto(
        new File(["second"], "second.jpg", { type: "image/jpeg" }),
      );
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    await db.saveDraft(session.getCurrentCheck());
    const saved = await db.getDraft("perimeter");
    return {
      count: saved.items.length,
      status: saved.items[0].analysis.status,
      identity: session.getCurrentCheck().items[0] === first,
    };
  });
  expect(result).toEqual({ count: 2, status: "waiting", identity: true });
});

test("Blob storage failures fall back to binary bytes and survive reload", async ({
  page,
}) => {
  const key = await page.evaluate(async () => {
    const { session } = window;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (
        this.name === "captureMedia" &&
        (value.original instanceof Blob || value.thumbnail instanceof Blob)
      )
        throw new DOMException(
          "Error preparing Blob/File data to be stored in object store",
          "UnknownError",
        );
      return put.call(this, value, ...args);
    };
    try {
      const item = await session.addCapturedPhoto(
        new File([new Uint8Array([0, 17, 128, 255])], "synthetic.jpg", {
          type: "image/jpeg",
        }),
      );
      return item.media.key;
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  });
  await page.reload();
  const original = await page.evaluate(async (key) => {
    const db = await import("/src/db.js");
    const media = await db.getCaptureMedia(key);
    return {
      type: media.original.type,
      bytes: [...new Uint8Array(await media.original.arrayBuffer())],
    };
  }, key);
  expect(original).toEqual({ type: "image/jpeg", bytes: [0, 17, 128, 255] });
  await page.evaluate(async (key) => {
    const db = await import("/src/db.js");
    const check = await db.getDraft("perimeter");
    check.items[0].upload = {
      status: "uploaded",
      artifactId: "synthetic-artifact",
    };
    await db.saveDraft(check);
    await db.releaseCaptureOriginal(key, "synthetic-artifact");
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === "captureMedia" && value.thumbnail instanceof Blob)
        throw new DOMException(
          "Error preparing Blob/File data to be stored in object store",
          "UnknownError",
        );
      return put.call(this, value, ...args);
    };
    try {
      await db.cacheCaptureThumbnail(
        key,
        "synthetic-artifact",
        new Blob(["synthetic thumbnail"], { type: "image/webp" }),
      );
    } finally {
      IDBObjectStore.prototype.put = put;
    }
  }, key);
  await page.reload();
  const cached = await page.evaluate(async (key) => {
    const db = await import("/src/db.js");
    const media = await db.getCaptureMedia(key);
    return {
      original: !!media.original,
      type: media.thumbnail.type,
      text: await media.thumbnail.text(),
    };
  }, key);
  expect(cached).toEqual({
    original: false,
    type: "image/webp",
    text: "synthetic thumbnail",
  });
});
