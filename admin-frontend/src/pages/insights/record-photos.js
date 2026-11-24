// Photos and notes on a Check or Issue record, with the System status page's
// thumbnail strip and full-size dialog.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { adminApi } from "../../services/admin-api.js";
import "../../system-status.css";
import {
  failedView,
  failureText,
  formatInstant,
  loadingView,
} from "./insights.templates.js";
import { closeOnBackdrop } from "./modal-backdrop.js";

/** @typedef {{ artifactId: string, source: "check" | "update", takenAt: string | null, thumbnailUrl: string, url: string, urlExpiresAt?: string, urlSeconds?: number }} Photo */
/** @typedef {{ source: "check" | "update", at: string | null, text: string }} Note */
/** @typedef {{ photos: Photo[], notes: Note[] }} PhotosReply */
/** @typedef {{ first: Promise<PhotosReply>, read: () => Promise<PhotosReply> }} PhotosRead */

/** @param {Photo} photo */
const openLabel = (photo) =>
  photo.takenAt
    ? t(`admin.insights.record.photoOpen.${photo.source}`, {
        time: formatInstant(photo.takenAt),
      })
    : t(`admin.insights.record.photoOpenUndated.${photo.source}`);

/** @param {{ photos: Photo[], notes: Note[], level: 2 | 3 }} view */
export function recordPhotosView({ photos, notes, level }) {
  const h = `h${level}`;
  const head = `<${h}>${escapeHtml(t("admin.insights.record.photos"))}</${h}>`;
  if (!photos.length && !notes.length)
    return `${head}<p class="muted" data-photos-empty>${escapeHtml(t("admin.insights.record.photosNone"))}</p>`;
  const strip = photos.length
    ? `<div class="status-filmstrip" data-photo-strip>${photos
        .map(
          (p) =>
            `<button type="button" class="btn-secondary status-tile" data-photo-open="${escapeHtml(p.artifactId)}" aria-label="${escapeHtml(openLabel(p))}"><img src="${escapeHtml(p.thumbnailUrl)}" alt="" loading="lazy"><small>${escapeHtml(formatInstant(p.takenAt))}</small></button>`,
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

/** @param {Element} from */
const isManager = (from) =>
  /** @type {any} */ (from.closest("admin-insights-page"))?.session?.role ===
  "compliance-manager";

/**
 * Starts the photos read, so it runs beside the record's own read. Null when
 * there's nothing to read: photos are for supervisors only.
 * @param {Element} from any element on the page, for the signed-in role
 * @param {{ kind: "issue" | "check", id: string, siteId: string }} record
 * @param {AbortSignal} signal
 * @returns {PhotosRead | null}
 */
export function readRecordPhotos(from, record, signal) {
  if (!record.siteId || isManager(from)) return null;
  const read = () => {
    const reply = adminApi.recordPhotos(
      record.siteId,
      record.kind === "issue" ? { issueId: record.id } : { checkId: record.id },
      signal,
    );
    // showRecordPhotos handles the failure; until it waits on it, it isn't unhandled.
    reply.catch(() => {});
    return reply;
  };
  return { first: read(), read };
}

// A length, not the server's time, so a wrong clock here can't keep an expired link.
const PHOTO_LINK_MS = 300_000;

/** A minute early, so a click never opens a link that runs out as it loads. @param {Photo} photo @param {number} readAt */
const linkRunningOut = (photo, readAt) =>
  Date.now() - readAt >=
  (typeof photo.urlSeconds === "number"
    ? photo.urlSeconds * 1000
    : PHOTO_LINK_MS) -
    60_000;

/** @param {HTMLElement} region @param {string} id */
const photoButton = (region, id) =>
  /** @type {HTMLElement | null} */ (
    region.querySelector(`[data-photo-open="${CSS.escape(id)}"]`)
  );

/**
 * Fills a record's photos region.
 * @param {HTMLElement | null} region the record body's [data-record-photos]
 * @param {PhotosRead | null} photos from readRecordPhotos
 * @param {{ level: 2 | 3, signal: AbortSignal }} options
 */
export async function showRecordPhotos(region, photos, { level, signal }) {
  if (!region) return;
  if (!photos) return region.remove();
  // Retry is about to go, so focus waits on the region instead of falling to the page.
  if (region.contains(document.activeElement)) {
    region.tabIndex = -1;
    region.focus();
  }
  region.innerHTML = loadingView();
  /** @type {PhotosReply} */
  let reply;
  try {
    reply = await photos.first;
  } catch (err) {
    if (signal.aborted || /** @type {any} */ (err)?.name === "AbortError")
      return;
    // Only the supervisors-only refusal hides the region; a blocked request can be retried.
    if (/** @type {any} */ (err)?.message === "supervisor_required")
      return region.remove();
    region.innerHTML = failedView(
      failureText(err, t("admin.insights.record.photosFailed")),
      "insights-photos-retry",
    );
    region.onclick = (event) => {
      if (
        !(
          /** @type {Element} */ (event.target).closest(
            "#insights-photos-retry",
          )
        )
      )
        return;
      void showRecordPhotos(
        region,
        { first: photos.read(), read: photos.read },
        { level, signal },
      );
    };
    return;
  }
  if (signal.aborted) return;
  let readAt = Date.now();
  /** @type {PhotosReply} */
  let shown = reply;
  const draw = () => {
    const active = document.activeElement;
    const focusedId =
      active && region.contains(active)
        ? active.getAttribute("data-photo-open")
        : null;
    region.innerHTML = recordPhotosView({ ...reply, level });
    shown = reply;
    if (focusedId) photoButton(region, focusedId)?.focus();
  };
  draw();
  /** @type {Promise<boolean> | null} */
  let renewing = null;
  // Resolves false when no new link came, so a click can say so.
  const renew = () =>
    (renewing ??= photos
      .read()
      .then(
        (next) => {
          if (signal.aborted) return false;
          reply = next;
          readAt = Date.now();
          // Redrawing would take the open photo away; it redraws on close instead.
          if (!region.querySelector("#insights-photo-viewer")) draw();
          return true;
        },
        () => false,
      )
      .finally(() => {
        renewing = null;
      }));
  // A thumbnail whose link ran out loads again with a new one.
  region.addEventListener(
    "error",
    (event) => {
      const img = /** @type {Element} */ (event.target);
      if (
        img.tagName === "IMG" &&
        shown.photos.some((p) => linkRunningOut(p, readAt))
      )
        void renew();
    },
    true,
  );
  region.onclick = async (event) => {
    const button = /** @type {Element} */ (event.target).closest(
      "[data-photo-open]",
    );
    const id = button?.getAttribute("data-photo-open");
    if (!id) return;
    const before = shown.photos.find((p) => p.artifactId === id);
    if (!before) return;
    region.querySelector("[data-photo-error]")?.remove();
    if (linkRunningOut(before, readAt) && !(await renew())) {
      if (signal.aborted) return;
      // The old link has run out, so opening it would show a broken image.
      region
        .querySelector("[data-photo-strip]")
        ?.insertAdjacentHTML(
          "afterend",
          `<p class="error" role="alert" data-photo-error>${escapeHtml(t("admin.insights.record.photoRenewFailed"))}</p>`,
        );
      return;
    }
    const photo = shown.photos.find((p) => p.artifactId === id);
    const opener = photoButton(region, id);
    if (!photo || !opener || signal.aborted) return;
    openPhoto(region, photo, () => {
      if (shown !== reply) draw();
      photoButton(region, id)?.focus();
    });
  };
}

/**
 * @param {HTMLElement} region
 * @param {Photo} photo
 * @param {() => void} closed puts focus back
 */
function openPhoto(region, photo, closed) {
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
    if (/** @type {Element} */ (event.target).closest("[data-photo-close]"))
      viewer.close();
  });
  closeOnBackdrop(viewer, () => viewer.close());
  viewer.addEventListener("close", () => {
    viewer.remove();
    closed();
  });
  viewer.showModal();
  /** @type {HTMLElement} */ (
    viewer.querySelector("[data-photo-close]")
  ).focus();
}
