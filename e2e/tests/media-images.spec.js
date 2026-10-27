import { test, expect } from "@playwright/test";

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Photo recovery</title><style>artifact-photo{width:220px;height:160px}button{padding:0;border:0}</style></head><body><button data-photo-lightbox aria-label="Open photo"><artifact-photo data-check-id="check" data-artifact-id="photo"><img data-src="/old.svg" alt="Test photo" /></artifact-photo></button><script type="module" src="/src/main.js"></script></body></html>`;
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="160"><rect width="220" height="160" fill="#6699aa"/></svg>';
/** @param {import("@playwright/test").Page} page @param {(route:import("@playwright/test").Route)=>Promise<void>} sign @param {string} html */
async function open(page, sign, html = fixture) {
  await page.route("**/photo-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route("**/v1/**", async (route) => {
    if (route.request().url().includes("/artifacts/photo/media"))
      return sign(route);
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.goto("/photo-fixture");
  await page.waitForFunction(() => window.customElements.get("artifact-photo"));
}

test("renews mounted and remounted photos after the signed URL lifetime", async ({
  page,
}) => {
  let calls = 0;
  await page.clock.install();
  await page.route("**/photo-*.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }),
  );
  await open(page, (route) =>
    route.fulfill({
      contentType: "application/json",
      json: { downloadUrl: `/photo-${++calls}.svg`, expiresIn: 300 },
    }),
  );
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/photo-1.svg",
  );
  await page.clock.fastForward(301000);
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/photo-2.svg",
  );
  await expect(page.locator("[data-photo-lightbox]")).toHaveAttribute(
    "data-full-src",
    "/photo-2.svg",
  );
  await page.evaluate(() => {
    const photo = document.querySelector("artifact-photo");
    if (!photo) throw new Error("Missing photo fixture");
    photo.replaceWith(photo.cloneNode(true));
  });
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/photo-2.svg",
  );
  expect(calls).toBe(2);
});

test("recovers a temporary signing failure with bounded retries", async ({
  page,
}) => {
  let calls = 0;
  await page.clock.install();
  await page.route("**/recovered.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }),
  );
  await open(page, (route) =>
    ++calls === 1
      ? route.fulfill({ status: 429, json: { error: "busy" } })
      : route.fulfill({
          json: { downloadUrl: "/recovered.svg", expiresIn: 300 },
        }),
  );
  await expect(page.locator("artifact-photo")).toHaveAttribute(
    "data-unavailable",
    "",
  );
  await page.clock.fastForward(6000);
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/recovered.svg",
  );
  await expect(page.locator("artifact-photo")).not.toHaveAttribute(
    "data-unavailable",
  );
  expect(calls).toBe(2);
});

test("falls back from a missing thumbnail to the original", async ({
  page,
}) => {
  let calls = 0;
  await page.clock.install();
  await page.route("**/missing-thumb.svg", (route) =>
    route.fulfill({ status: 404 }),
  );
  await page.route("**/original-*.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }),
  );
  await open(page, (route) => {
    calls++;
    return route.fulfill({
      json: {
        downloadUrl: `/original-${calls}.svg`,
        thumbnailUrl: "/missing-thumb.svg",
        expiresIn: 300,
      },
    });
  });
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/original-2.svg",
  );
  await expect(page.locator("artifact-photo")).not.toHaveAttribute(
    "data-unavailable",
  );
  expect(calls).toBe(2);
  await page.clock.fastForward(301000);
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/original-3.svg",
  );
  await expect(page.locator("artifact-photo")).not.toHaveAttribute(
    "data-unavailable",
  );
  expect(calls).toBe(3);
});

test("shows an accessible gray placeholder for missing older photos without a retry loop", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/missing-*.svg", (route) =>
    route.fulfill({ status: 404 }),
  );
  await open(page, (route) => {
    calls++;
    return route.fulfill({
      json: {
        downloadUrl: "/missing-original.svg",
        thumbnailUrl: "/missing-thumb.svg",
        expiresIn: 300,
      },
    });
  });
  await expect(
    page.getByRole("img", { name: "Image unavailable" }),
  ).toBeVisible();
  await expect(
    page.locator('artifact-photo wa-icon[name="image-slash"]'),
  ).toBeVisible();
  await expect(page.locator("[data-photo-lightbox]")).toBeDisabled();
  expect(calls).toBe(2);
  await page.evaluate(() => {
    const photo = document.querySelector("artifact-photo");
    if (!photo) throw new Error("Missing photo fixture");
    photo.replaceWith(photo.cloneNode(true));
  });
  await expect(
    page.getByRole("img", { name: "Image unavailable" }),
  ).toBeVisible();
  expect(calls).toBe(2);
});

test("stops automatic retries after repeated signing failures", async ({
  page,
}) => {
  let calls = 0;
  await page.clock.install();
  await open(page, (route) => {
    calls++;
    return route.fulfill({ status: 503, json: { error: "unavailable" } });
  });
  await expect(page.locator("artifact-photo")).toHaveAttribute(
    "data-unavailable",
    "",
  );
  await page.clock.fastForward(6000);
  await expect.poll(() => calls).toBe(2);
  await page.clock.fastForward(6000);
  await expect.poll(() => calls).toBe(3);
  await page.clock.fastForward(60000);
  expect(calls).toBe(3);
});

test("keeps local capture previews without requesting a not-yet-uploaded artifact", async ({
  page,
}) => {
  let calls = 0;
  const src = "data:image/svg+xml," + encodeURIComponent(svg);
  await open(
    page,
    (route) => {
      calls++;
      return route.fulfill({ status: 404 });
    },
    fixture.replace("/old.svg", src),
  );
  await expect(page.locator("artifact-photo img")).toHaveAttribute("src", src);
  expect(calls).toBe(0);
});

test("shows unavailable photos within actual in-progress and history cards", async ({
  page,
}) => {
  await page.route("**/missing-*.svg", (route) =>
    route.fulfill({ status: 404 }),
  );
  await open(page, (route) =>
    route.fulfill({
      json: { downloadUrl: "/missing-original.svg", expiresIn: 300 },
    }),
  );
  await page.evaluate(async () => {
    const path = "/src/components/analysis-results.templates.js";
    const { taskAnalysisCard } = await import(path);
    const task = {
      taskId: "task",
      checkId: "check",
      sourceArtifactIds: ["photo"],
      status: "in_progress",
      mediaUrl: "/missing-original.svg",
      category: "Litter",
      description: "Test issue",
      evidence: { artifactId: "photo", kind: "photo" },
    };
    document.body.innerHTML =
      taskAnalysisCard({ task, readOnly: true }) +
      taskAnalysisCard({
        task: { ...task, taskId: "history", status: "completed" },
        history: true,
      });
  });
  await expect(
    page.getByRole("img", { name: "Image unavailable" }),
  ).toHaveCount(2);
  for (const p of await page.locator("artifact-photo").all()) {
    await expect(p).toBeVisible();
    const gray = await p.evaluate(
      (e) => window.getComputedStyle(e).backgroundColor,
    );
    expect(gray).not.toBe("rgba(0, 0, 0, 0)");
    expect((await p.boundingBox())?.height ?? 0).toBeGreaterThan(50);
  }
  await expect(page.locator(".analysis-card__media button")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.keyboard.press("Tab");
  await expect(page.locator(".history-card__row")).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("unavailable-cards.png"),
  });
});

test("reattaching a photo during signing cannot strand it or duplicate the request", async ({
  page,
}) => {
  let calls = 0;
  /** @type {()=>void} */ let release = () => {
    throw new Error("Signing did not start");
  };
  await page.route("**/reattached.svg", (route) =>
    route.fulfill({ contentType: "image/svg+xml", body: svg }),
  );
  await open(page, (route) => {
    calls++;
    return /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        release = () => {
          void route
            .fulfill({
              json: { downloadUrl: "/reattached.svg", expiresIn: 300 },
            })
            .then(() => resolve());
        };
      })
    );
  });
  await expect.poll(() => calls).toBe(1);
  await page.evaluate(() => {
    const photo = document.querySelector("artifact-photo"),
      parent = photo?.parentElement;
    if (!photo || !parent) throw new Error("Missing photo");
    photo.remove();
    parent.append(photo);
  });
  release();
  await expect(page.locator("artifact-photo img")).toHaveAttribute(
    "src",
    "/reattached.svg",
  );
  expect(calls).toBe(1);
});
