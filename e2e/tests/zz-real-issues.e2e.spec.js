// @ts-check
// TEMPORARY probe — real-data issues quarter diagnosis. Delete after.
import { test } from "@playwright/test";
import { bindSite } from "../helpers/app.js";

test("diagnose real quarter issues data", async ({ page }) => {
  const payloads = [];
  page.on("response", async (response) => {
    if (response.url().includes("/reports/tasks?")) {
      try {
        payloads.push(await response.json());
      } catch {}
    }
  });

  await bindSite(page);
  await page.goto("/reports?tab=issues&period=month&start=2026-09-01");
  await page.waitForTimeout(800);

  const r = await page.evaluate(() => {
    const svgs = document.querySelectorAll(".reports-chart");
    const svg = svgs[0];
    const found = [...document.querySelectorAll(".reports-chart__bar--found")];
    const boxes = found.map((f) => {
      const b = f.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height * 10) / 10 };
    });
    const title = document.querySelector("h3.reports__card-title");
    return {
      headline: document.querySelector(".reports__headline-title")?.textContent
        ?? document.querySelector(".reports__status")?.textContent
        ?? "",
      chartTitle: title?.textContent ?? "",
      svgCount: svgs.length,
      svgSize: svg
        ? {
            w: Math.round(svg.getBoundingClientRect().width),
            h: Math.round(svg.getBoundingClientRect().height),
          }
        : null,
      viewBox: svg?.getAttribute("viewBox") ?? null,
      barCount: found.length,
      nonZeroBars: boxes.filter((b) => b.h > 0.5),
      sampleBars: boxes.slice(0, 4),
      recordRows: document.querySelectorAll(".reports__record").length,
      rowFirstSubtitle: document
        .querySelector(".reports__record-sub")
        ?.textContent?.slice(0, 40),
      tickTexts: [...document.querySelectorAll(".reports-chart__tick")]
        .filter((t) => t.textContent)
        .map((t) => t.textContent),
    };
  });
  console.log("REAL PAGE:", JSON.stringify(r, null, 2));
  console.log(
    "ENDPOINT PAYLOADS:",
    payloads
      .map((p) => ({
        kind: p.period?.kind,
        start: p.period?.start,
        taskCount: (p.tasks ?? []).length,
        firstTasks: (p.tasks ?? []).slice(0, 3).map((t) => ({
          status: t.status,
          kind: t.kind,
          createdAt: t.createdAt,
        })),
      }))
      .map((p) => JSON.stringify(p)),
  );
});