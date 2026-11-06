// Photos and notes on a Check or Issue record, with the System status page's
// thumbnail strip and full-size dialog.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { adminApi } from "../../services/admin-api.js";
import "../../system-status.css";
import { formatInstant, loadingView } from "./insights.templates.js";

/** @typedef {{ artifactId: string, source: "check" | "update", takenAt: string | null, thumbnailUrl: string, url: string }} Photo */
/** @typedef {{ source: "check" | "update", at: string | null, text: string }} Note */

/** @param {{ photos: Photo[], notes: Note[], level: 2 | 3 }} view */
export function recordPhotosView({ photos, notes, level }) {
  const h = `h${level}`;
  const head = `<${h}>${escapeHtml(t("admin.insights.record.photos"))}</${h}>`;
  if (!photos.length && !notes.length)
    return `${head}<p class="muted" data-photos-empty>${escapeHtml(t("admin.insights.record.photosNone"))}</p>`;
  const strip = photos.length
    ? `<div class="status-filmstrip" data-photo-strip>${photos
        .map(
          (p, i) =>
            `<button type="button" class="btn-secondary status-tile" data-photo-open="${i}" aria-label="${escapeHtml(t(`admin.insights.record.photoOpen.${p.source}`, { time: formatInstant(p.takenAt) }))}"><img src="${escapeHtml(p.thumbnailUrl)}" alt="" loading="lazy"><small>${escapeHtml(formatInstant(p.takenAt))}</small></button>`,
        )
        .join("")}</div>`
    : "";
  const list = notes.length
    ? `<ul class="insights__timeline" data-record-notes>${notes
        .map(
          (n) =>
            `<li data-note-source="${n.source}">${n.at ? `<time datetime="${escapeHtml(n.at)}">${escapeHtml(formatInstant(n.at))}</time> ` : ""}<span class="muted">${escapeHtml(t(`admin.insights.record.noteFrom.${n.source}`))}</span> ${escapeHtml(n.text)}</li>`,
        )
        .join("")}</ul>`
    : "";
  return `${head}${strip}${list}`;
}

/**
 * Fills a record's photos region. Managers can't read photos, so the region
 * goes away for them instead of showing an error.
 * @param {HTMLElement | null} region the record body's [data-record-photos]
 * @param {{ kind: "issue" | "check", id: string, siteId: string, level: 2 | 3 }} record
 * @param {AbortSignal} signal
 */
export async function showRecordPhotos(region, record, signal) {
  if (!region || !record.siteId) return region?.remove();
  region.innerHTML = loadingView();
  /** @type {{ photos: Photo[], notes: Note[] }} */
  let reply;
  try {
    reply = await adminApi.recordPhotos(
      record.siteId,
      record.kind === "issue" ? { issueId: record.id } : { checkId: record.id },
      signal,
    );
  } catch (err) {
    if (/** @type {any} */ (err)?.name === "AbortError") return;
    if (/** @type {any} */ (err)?.status === 403) return region.remove();
    region.innerHTML = `<p class="muted" data-photos-failed>${escapeHtml(t("admin.insights.record.photosFailed"))}</p>`;
    return;
  }
  if (signal.aborted) return;
  region.innerHTML = recordPhotosView({ ...reply, level: record.level });
  region.onclick = (event) => {
    const button = /** @type {Element} */ (event.target).closest(
      "[data-photo-open]",
    );
    if (!button) return;
    const photo = reply.photos[Number(button.getAttribute("data-photo-open"))];
    if (photo) openPhoto(region, photo, /** @type {HTMLElement} */ (button));
  };
}

/**
 * @param {HTMLElement} region
 * @param {Photo} photo
 * @param {HTMLElement} opener focus returns here
 */
function openPhoto(region, photo, opener) {
  region.querySelector("#insights-photo-viewer")?.remove();
  region.insertAdjacentHTML(
    "beforeend",
    `<dialog class="status-dialog" id="insights-photo-viewer" aria-label="${escapeHtml(t("admin.insights.record.photoViewer"))}">
      <button type="button" class="btn-secondary" data-photo-close>${escapeHtml(t("common.close"))}</button>
      <div class="status-pair"><figure><img src="${escapeHtml(photo.url)}" alt="${escapeHtml(t(`admin.insights.record.photoAlt.${photo.source}`))}"><figcaption>${escapeHtml(formatInstant(photo.takenAt))}</figcaption></figure></div>
    </dialog>`,
  );
  const viewer = /** @type {HTMLDialogElement} */ (
    region.querySelector("#insights-photo-viewer")
  );
  // The record panel closes on Esc and outside clicks; this dialog sits inside it.
  viewer.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    viewer.close();
  });
  viewer.addEventListener("click", (event) => {
    event.stopPropagation();
    const target = /** @type {Element} */ (event.target);
    const r = viewer.getBoundingClientRect();
    // Padding inside the dialog is the dialog too; only the backdrop is outside its box.
    const backdrop =
      target === viewer &&
      (event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom);
    if (backdrop || target.closest("[data-photo-close]")) viewer.close();
  });
  viewer.addEventListener("close", () => {
    viewer.remove();
    if (opener.isConnected) opener.focus();
  });
  viewer.showModal();
  /** @type {HTMLElement} */ (
    viewer.querySelector("[data-photo-close]")
  ).focus();
}
