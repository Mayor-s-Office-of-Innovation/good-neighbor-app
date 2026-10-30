import { shotTile, descriptionCard } from "./perimeter-check.templates.js";
import { analysisScanner } from "./capture-analysis.templates.js";
import { patchHtml } from "../lib/patch-html.js";

const grids = new WeakMap();
/** Keep the roll's images mounted across progress updates. @param {Element} grid @param {any[]} photos @param {any} description */
export function renderCaptureGrid(grid, photos, description) {
  let entries = grids.get(grid);
  if (!entries) {
    entries = new Map();
    grids.set(grid, entries);
  }
  let text = grid.querySelector("[data-description-slot]");
  if (description) {
    if (!text) {
      text = document.createElement("div");
      text.setAttribute("data-description-slot", "");
      text.setAttribute("style", "display:contents");
      grid.prepend(text);
    }
    if (grid.firstElementChild !== text) grid.prepend(text);
    patchHtml(text, descriptionCard(description));
  } else text?.remove();
  const wanted = new Set();
  let cursor = description ? text.nextElementSibling : grid.firstElementChild;
  for (const [item, index] of [...photos.entries()]
    .reverse()
    .map(([i, p]) => [p, i])) {
    wanted.add(item.id);
    let entry = entries.get(item.id);
    if (!entry) {
      const element = document.createElement("div");
      entry = { element };
      entries.set(item.id, entry);
    }
    const source = item.dataUrl;
    const meta = JSON.stringify([
      index,
      item.media,
      item.checkId,
      item.upload?.artifactId,
      item.analysis?.artifactId,
      item.georeferencedAddress,
      item.address,
      item.siteAddress,
      item.uploadedAt,
      item.createdAt,
      item.capturedAt,
      document.documentElement.lang,
    ]);
    if (
      entry.source !== source ||
      entry.meta !== meta ||
      !entry.element.firstChild
    ) {
      patchHtml(
        entry.element,
        shotTile(
          { ...item, analysis: { ...item.analysis, status: "idle" } },
          index,
        ),
      );
      entry.source = source;
      entry.meta = meta;
    }
    const preview = entry.element.querySelector(".shot__preview");
    const scanner = analysisScanner(item);
    const old = preview.querySelector(".capture-scanner");
    if (scanner && !old) preview.insertAdjacentHTML("beforeend", scanner);
    if (!scanner && old) old.remove();
    // The wrapper uses display:contents so the original tile remains the grid item.
    entry.element.style.display = "contents";
    if (entry.element !== cursor) grid.insertBefore(entry.element, cursor);
    cursor = entry.element.nextElementSibling;
  }
  for (const [id, entry] of entries)
    if (!wanted.has(id)) {
      entry.element.remove();
      entries.delete(id);
    }
}
