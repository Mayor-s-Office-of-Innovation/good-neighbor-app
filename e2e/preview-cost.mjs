/* global Blob, File, FileReader, Worker, Image, performance, requestAnimationFrame, cancelAnimationFrame, PerformanceObserver, setInterval, clearInterval */
// Isolated synthetic experiment: no application writes, uploads, or dependencies.
// node e2e/preview-cost.mjs --rates=1,4 --repeats=3 --count=11
import { chromium } from "@playwright/test";
import { cpus, platform, arch } from "node:os";

const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1] ||
  fallback;
const rates = option("rates", "1,4").split(",").map(Number);
const repeats = Number(option("repeats", "3"));
const count = Number(option("count", "11"));
const [width, height] = option("size", "4032x3024").split("x").map(Number);
const modes = option("modes", "base64,blob,main480,worker480,worker320").split(
  ",",
);
if (
  ![...rates, repeats, count, width, height].every(
    (n) => Number.isFinite(n) && n > 0,
  )
)
  throw new Error("Options must be positive numbers");
const runs = [];
const browser = await chromium.launch();
try {
  for (const rate of rates)
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Rotate ordering to reduce systematic warm-up/thermal bias.
      const order = modes
        .slice(repeat % modes.length)
        .concat(modes.slice(0, repeat % modes.length));
      for (const mode of order) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
        });
        const page = await context.newPage();
        await page.setContent(
          '<!doctype html><html lang="en"><head><title>Synthetic preview experiment</title><style>body{margin:0}#gallery{display:grid;grid-template-columns:repeat(3,120px);gap:8px}img{width:120px;height:90px;object-fit:cover}</style></head><body><div id="gallery"></div></body></html>',
        );
        // Prepare inputs before throttling and measuring. Seed is identical across modes.
        const fixtureBytes = await page.evaluate(
          async ({ width, height, count }) => {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            let pixels = ctx.createImageData(width, height);
            let seed = 12345;
            for (let i = 0; i < pixels.data.length; i += 4) {
              seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
              pixels.data[i] = seed & 255;
              pixels.data[i + 1] = (seed >>> 8) & 255;
              pixels.data[i + 2] = (seed >>> 16) & 255;
              pixels.data[i + 3] = 255;
            }
            ctx.putImageData(pixels, 0, 0);
            const jpeg = await new Promise((resolve) =>
              canvas.toBlob(resolve, "image/jpeg", 0.35),
            );
            pixels = null;
            canvas.width = canvas.height = 0;
            window.previewFiles = Array.from(
              { length: count },
              (_, i) =>
                new File([jpeg, new Uint8Array([i])], `synthetic-${i}.jpg`, {
                  type: "image/jpeg",
                }),
            );
            return jpeg.size;
          },
          { width, height, count },
        );
        const cdp = await context.newCDPSession(page);
        await cdp.send("HeapProfiler.collectGarbage");
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        const result = await page.evaluate(
          async ({ mode, width, height }) => {
            const frame = () =>
              new Promise((resolve) => requestAnimationFrame(resolve));
            const sleep = (ms) =>
              new Promise((resolve) => setTimeout(resolve, ms));
            const samples = [],
              frameGaps = [],
              timerLateness = [],
              longTasks = [];
            let lastFrame,
              frameId,
              recording = false;
            const monitor = (now) => {
              if (recording && lastFrame !== undefined)
                frameGaps.push(now - lastFrame);
              lastFrame = now;
              frameId = requestAnimationFrame(monitor);
            };
            frameId = requestAnimationFrame(monitor);
            let lastTick = performance.now();
            const timer = setInterval(() => {
              const now = performance.now();
              if (recording)
                timerLateness.push(Math.max(0, now - lastTick - 16));
              lastTick = now;
            }, 16);
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries())
                if (entry.startTime >= started && entry.startTime <= ended)
                  longTasks.push(entry.duration);
            });
            observer.observe({ type: "longtask", buffered: false });
            let worker,
              workerUrl,
              started = Infinity,
              ended = Infinity;
            const urls = [];
            const dataUrls = [];
            let retainedBytes = 0;
            const edge = mode.endsWith("320") ? 320 : 480;
            const targetWidth = Math.round(
                (width * edge) / Math.max(width, height),
              ),
              targetHeight = Math.round(
                (height * edge) / Math.max(width, height),
              );
            const createWorker = () => {
              workerUrl = URL.createObjectURL(
                new Blob(
                  [
                    `
            onmessage = async ({data}) => {
              let bitmap, canvas;
              try {
                const start = performance.now();
                bitmap = await createImageBitmap(data.file);
                data.file = null;
                const decoded = performance.now();
                canvas = new OffscreenCanvas(data.width, data.height);
                canvas.getContext("2d").drawImage(bitmap, 0, 0, data.width, data.height);
                bitmap.close(); bitmap = null;
                const blob = await canvas.convertToBlob({type:"image/jpeg", quality:0.75});
                postMessage({blob, workerMs:performance.now()-start, decodeMs:decoded-start});
              } catch (error) { postMessage({error:String(error)}); }
              finally { bitmap?.close(); if(canvas) canvas.width=canvas.height=0; }
            };`,
                  ],
                  { type: "text/javascript" },
                ),
              );
              worker = new Worker(workerUrl);
            };
            const thumbnailInWorker = (file) =>
              new Promise((resolve, reject) => {
                if (!worker) createWorker();
                worker.onmessage = ({ data }) =>
                  data.error ? reject(new Error(data.error)) : resolve(data);
                worker.onerror = (event) => reject(new Error(event.message));
                worker.postMessage({
                  file,
                  width: targetWidth,
                  height: targetHeight,
                });
              });
            const thumbnailOnMain = async (file) => {
              const url = URL.createObjectURL(file);
              const image = new Image();
              const canvas = document.createElement("canvas");
              try {
                image.src = url;
                await image.decode();
                canvas.width = targetWidth;
                canvas.height = targetHeight;
                canvas
                  .getContext("2d")
                  .drawImage(image, 0, 0, targetWidth, targetHeight);
                return await new Promise((resolve, reject) =>
                  canvas.toBlob(
                    (blob) =>
                      blob
                        ? resolve(blob)
                        : reject(new Error("Encoding failed")),
                    "image/jpeg",
                    0.75,
                  ),
                );
              } finally {
                image.removeAttribute("src");
                URL.revokeObjectURL(url);
                canvas.width = canvas.height = 0;
              }
            };
            await sleep(120);
            await frame();
            started = performance.now();
            recording = true;
            try {
              for (const file of window.previewFiles) {
                const start = performance.now();
                let src,
                  workerMs = null,
                  decodeMs = null;
                if (mode === "base64") {
                  src = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = () => reject(reader.error);
                    reader.readAsDataURL(file);
                  });
                  dataUrls.push(src);
                  retainedBytes += src.length;
                } else {
                  let blob = file;
                  if (mode === "main480") blob = await thumbnailOnMain(file);
                  else if (mode.startsWith("worker")) {
                    const result = await thumbnailInWorker(file);
                    blob = result.blob;
                    workerMs = result.workerMs;
                    decodeMs = result.decodeMs;
                  } else if (mode !== "blob")
                    throw new Error(`Unknown mode ${mode}`);
                  retainedBytes += blob.size;
                  src = URL.createObjectURL(blob);
                  urls.push(src);
                }
                const prepared = performance.now();
                const image = new Image();
                image.alt = "Synthetic benchmark photo";
                image.decoding = "async";
                image.src = src;
                document.querySelector("#gallery").append(image);
                await image.decode();
                const fullSize = mode === "base64" || mode === "blob";
                if (
                  image.naturalWidth !== (fullSize ? width : targetWidth) ||
                  image.naturalHeight !== (fullSize ? height : targetHeight)
                )
                  throw new Error("Unexpected preview dimensions");
                const decoded = performance.now();
                await frame();
                await frame();
                samples.push({
                  prepareMs: prepared - start,
                  decodedMs: decoded - start,
                  visibleMs: performance.now() - start,
                  workerMs,
                  decodeMs,
                });
              }
              ended = performance.now();
              recording = false;
              await sleep(80);
              return {
                mode,
                samples,
                totalMs: ended - started,
                retainedPreviewBytes: retainedBytes,
                retainedBytesMeaning:
                  mode === "base64"
                    ? "ASCII characters (not JS heap size)"
                    : "compressed binary bytes referenced by preview URLs",
                decodedPixelBytesEstimate:
                  window.previewFiles.length *
                  (mode === "base64" || mode === "blob"
                    ? width * height * 4
                    : targetWidth * targetHeight * 4),
                frameGaps,
                timerLateness,
                longTasks,
              };
            } finally {
              recording = false;
              clearInterval(timer);
              cancelAnimationFrame(frameId);
              observer.disconnect();
              document.querySelector("#gallery").replaceChildren();
              for (const url of urls) URL.revokeObjectURL(url);
              dataUrls.length = 0;
              worker?.terminate();
              if (workerUrl) URL.revokeObjectURL(workerUrl);
              window.previewFiles = null;
            }
          },
          { mode, width, height },
        );
        runs.push({ rate, repeat, fixtureBytes, ...result });
        console.error(
          `completed ${mode}, throttle ${rate}, repeat ${repeat + 1}`,
        );
        await context.close();
      }
    }
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
    ] || 0;
  const summaries = [];
  for (const rate of rates)
    for (const mode of modes) {
      const group = runs.filter(
        (run) => run.rate === rate && run.mode === mode,
      );
      const samples = group.flatMap((run) => run.samples);
      summaries.push({
        rate,
        mode,
        prepareMedianMs: percentile(
          samples.map((s) => s.prepareMs),
          0.5,
        ),
        prepareP95Ms: percentile(
          samples.map((s) => s.prepareMs),
          0.95,
        ),
        visibleMedianMs: percentile(
          samples.map((s) => s.visibleMs),
          0.5,
        ),
        visibleP95Ms: percentile(
          samples.map((s) => s.visibleMs),
          0.95,
        ),
        firstVisibleMedianMs: percentile(
          group.map((r) => r.samples[0].visibleMs),
          0.5,
        ),
        frameGapP95Ms: percentile(
          group.flatMap((r) => r.frameGaps),
          0.95,
        ),
        frameGapMaxMs: Math.max(...group.flatMap((r) => r.frameGaps)),
        timerLatenessP95Ms: percentile(
          group.flatMap((r) => r.timerLateness),
          0.95,
        ),
        timerLatenessMaxMs: Math.max(...group.flatMap((r) => r.timerLateness)),
        longTasks: group.flatMap((r) => r.longTasks).length,
        maxLongTaskMs: Math.max(0, ...group.flatMap((r) => r.longTasks)),
        retainedPreviewBytes: group[0].retainedPreviewBytes,
        decodedPixelBytesEstimate: group[0].decodedPixelBytesEstimate,
      });
    }
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        host: { cpu: cpus()[0].model, platform: platform(), arch: arch() },
        width,
        height,
        count,
        repeats,
        caveats: [
          "Synthetic JPEGs; desktop browser, not a phone benchmark.",
          "CPU throttle is a stress experiment, not an older-phone model. Worker/native decode throttling may differ.",
          "Processing and decode wall time are not CPU time or UI blocking time.",
          "Frame/timer gaps and long tasks measure main-thread responsiveness, not camera launch or true interaction latency.",
          "Retained bytes exclude source files and browser overhead. Pixel-byte estimates are arithmetic, not measured RAM/GPU use.",
          "Each mode uses a fresh context, sequential processing, and keeps all previews mounted until the end. Original uploads/storage and the old full-grid rerenders are excluded.",
        ],
        summaries,
        runs,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
