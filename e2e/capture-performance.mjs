/* global localStorage, customElements, Blob, File, FileReader, IDBObjectStore, performance */
// Synthetic local microbenchmark. Start Vite on 5179, then run with node.
import { chromium } from "@playwright/test";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route("**/diagnostic", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body><div id="grid"></div><div id="tray"></div></body></html>',
    }),
  );
  await page.goto("http://127.0.0.1:5179/diagnostic");
  const result = await page.evaluate(
    async ({ binary, thumbnails, count: maxCount, quality }) => {
      localStorage.setItem("gnp:analytics", "off");
      localStorage.setItem("gnp:perf", "off");
      const { shell } = await import(
        "/src/components/perimeter-check.templates.js"
      );
      await import("/src/components/perimeter-check.js");
      const session = await import("/src/state/check-session.js");
      const host = document.createElement("div");
      host.innerHTML = shell();
      const proto = customElements.get("perimeter-check").prototype;
      for (const name of Object.getOwnPropertyNames(proto))
        if (name.startsWith("_") && typeof proto[name] === "function")
          host[name] = proto[name].bind(host);
      host._captureFiles = { busy: false };
      host._answeringConditionIds = new Set();
      document.body.append(host);
      const check = session.startCheck("synthetic-site");
      const { dataUrlToBlob } = await import("/src/services/api.js");
      const {
        saveDraft,
        getCaptureMedia,
        releaseCaptureOriginal,
        cacheCaptureThumbnail,
      } = await import("/src/db.js");
      await saveDraft(check);
      const c = document.createElement("canvas");
      c.width = 4032;
      c.height = 3024;
      const ctx = c.getContext("2d");
      const pixels = ctx.createImageData(c.width, c.height);
      let seed = 12345;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        pixels.data[i] = seed & 255;
        pixels.data[i + 1] = (seed >>> 8) & 255;
        pixels.data[i + 2] = (seed >>> 16) & 255;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      c.width = c.height = 0;
      const photos = [];
      for (let i = 0; i < maxCount; i++) {
        const file = new Blob([bytes, new Uint8Array([i])], {
          type: "image/jpeg",
        });
        if (binary) {
          photos.push(
            await session.addCapturedPhoto(
              new File([file], `synthetic-${i}.jpg`, { type: "image/jpeg" }),
            ),
          );
          continue;
        }
        const dataUrl = await new Promise((r) => {
          const reader = new FileReader();
          reader.onload = () => r(reader.result);
          reader.readAsDataURL(file);
        });
        photos.push({
          id: "synthetic-" + i,
          kind: "photo",
          dataUrl,
          analysis: { status: "queued" },
        });
      }
      if (thumbnails) {
        await import("/src/components/capture-photo.js");
        const small = document.createElement("canvas");
        small.width = 480;
        small.height = 360;
        const ctx = small.getContext("2d");
        ctx.fillStyle = "#708090";
        ctx.fillRect(0, 0, 480, 360);
        const thumb = await new Promise((resolve) =>
          small.toBlob(resolve, "image/webp", 0.75),
        );
        for (const item of photos)
          item.upload = { status: "uploaded", artifactId: item.id };
        await saveDraft(check);
        for (const item of photos) {
          await releaseCaptureOriginal(item.media.key, item.id);
          await cacheCaptureThumbnail(item.media.key, item.id, thumb);
        }
        small.width = small.height = 0;
      }
      const rows = [];
      const putTimes = [];
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const t = performance.now();
        const result = original.apply(this, args);
        putTimes.push(performance.now() - t);
        return result;
      };
      for (const count of [...new Set([1, 5, 11, maxCount])]) {
        const items = photos.slice(0, count);
        check.items = items;
        const runs = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          items.at(-1).analysis.status = repeat % 2 ? "analyzing" : "queued";
          let t = performance.now();
          host._render();
          const renderMs = performance.now() - t;
          host._stopElapsedTicker();
          if (host.querySelectorAll("#shotgrid .shot").length !== count)
            throw new Error(
              "Fixture session mismatch: restart Vite before benchmarking",
            );
          const start = putTimes.length;
          t = performance.now();
          await saveDraft(check);
          const saveMs = performance.now() - t;
          t = performance.now();
          if (binary) await getCaptureMedia(items.at(-1).media.key);
          else await dataUrlToBlob(items.at(-1).dataUrl);
          const preparationMs = performance.now() - t;
          runs.push({
            renderMs,
            saveMs,
            putSyncMs: putTimes.slice(start).reduce((a, b) => a + b, 0),
            preparationMs,
            htmlMiB: host.innerHTML.length / 1048576,
          });
          await new Promise((r) => setTimeout(r, 250));
        }
        rows.push({ count, runs });
      }
      return {
        mode: thumbnails ? "thumbnails" : binary ? "binary" : "legacy",
        jpegBytes: bytes.length,
        dimensions: [4032, 3024],
        rows,
      };
    },
    {
      binary:
        process.argv.includes("--binary") ||
        process.argv.includes("--thumbnails"),
      thumbnails: process.argv.includes("--thumbnails"),
      count: process.argv.includes("--twenty") ? 20 : 11,
      quality: process.argv.includes("--twenty") ? 0.18 : 0.35,
    },
  );
  console.log(
    JSON.stringify({ browser: browser.version(), ...result }, null, 2),
  );
} finally {
  await browser.close();
}
