/*
  Presentational templates for <perimeter-check>.

  The perimeter check is a flat photo roll (docs/plan-remove-places.md): one
  grid of photos for the whole perimeter, an optional single description as the
  alternative to photos, and a Finish button that unlocks once the completion
  rule in domain/check-completion.js is met. Every photo or description is
  analyzed independently as soon as it is captured.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { RECOMMENDED_PERIMETER_PHOTOS } from "../domain/check-completion.js";
import {
  analysisDialogs,
  analysisResultsTray,
  problemSummary,
  problemSummaryLabel,
} from "./analysis-results.templates.js";

export const shell = () => html`
  <div class="flow view-check check check-timeline check-roll">
    <div class="check-timeline__topbar">
      <span aria-hidden="true"></span>
      <button class="check-timeline__close" id="cancel" type="button">
        <span class="check-timeline__close-icon" aria-hidden="true"></span>
        <span class="visually-hidden"
          >${escapeHtml(t("check.close.aria"))}</span
        >
      </button>
    </div>

    <h1 class="check-timeline__title" tabindex="-1">
      ${escapeHtml(t("check.title"))}
    </h1>

    <p
      class="check-roll__progress"
      id="check-progress"
      role="status"
      aria-live="polite"
    ></p>

    <div
      class="shotgrid check-roll__grid"
      id="shotgrid"
      aria-label="${escapeAttr(t("check.grid.aria"))}"
    ></div>

    <button
      class="btn-outline check-roll__describe"
      id="describe-instead"
      type="button"
    >
      ${escapeHtml(t("check.describeInstead"))}
    </button>

    <div class="check-timeline__footer" id="check-footer"></div>

    ${analysisDialogs()}

    <dialog
      class="sheet"
      id="cancel-check-dialog"
      aria-label="${escapeAttr(t("check.cancelDialog.aria"))}"
    >
      <div class="sheet__panel">
        <div class="sheet__actions">
          <button class="sheet__cancel" type="button" id="cancel-check-save">
            ${escapeHtml(t("check.cancelDialog.save"))}
          </button>
        </div>
        <ul class="sheet__opts">
          <li>
            <button
              class="sheet__opt sheet__opt--danger"
              id="cancel-check-discard"
              type="button"
            >
              ${escapeHtml(t("check.cancelDialog.discard"))}
            </button>
          </li>
        </ul>
      </div>
    </dialog>

    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
    />
  </div>
`;

/**
 * Stacked capture status under the title. The description minimum is
 * instructional copy; the existing completion rule is unchanged.
 * @param {{ photos: number }} status
 * @returns {string}
 */
export function progressLine({ photos }) {
  return (
    `<strong>${escapeHtml(t("check.progress.count", { photos, recommended: RECOMMENDED_PERIMETER_PHOTOS }))}</strong>` +
    `<span>${escapeHtml(t("check.progress.hint"))}</span>`
  );
}

/**
 * The saved description (one per check) with edit / remove.
 * @param {{ id: string, text?: string } | null | undefined} item
 * @returns {string}
 */
export function descriptionCard(item) {
  if (!item) return "";
  return html`
    <section
      class="shot shot--description"
      aria-label="${escapeAttr(t("check.description.aria"))}"
    >
      <p class="shot__description">${escapeHtml(item.text || "")}</p>
      <button
        class="shot__del shot__edit"
        type="button"
        aria-label="${escapeAttr(t("check.description.edit"))}"
        data-edit-description="${escapeAttr(item.id)}"
      >
        <wa-icon name="pen" aria-hidden="true"></wa-icon>
      </button>
      <button
        class="shot__del"
        type="button"
        aria-label="${escapeAttr(t("check.description.delete"))}"
        data-remove-description="${escapeAttr(item.id)}"
      >
        <wa-icon name="trash" aria-hidden="true"></wa-icon>
      </button>
    </section>
  `;
}

/**
 * The photo roll: camera first, then captured tiles from newest to oldest.
 * @param {Array<{ id: string, dataUrl?: string }>} photos
 * @param {{ id: string, text?: string } | null | undefined} description
 * @returns {string}
 */
export function photoGrid(photos, description = null) {
  return (
    addTile(photos.length === 0 && !description) +
    descriptionCard(description) +
    photos
      .map((item, index) => shotTile(item, index))
      .reverse()
      .join("")
  );
}

/**
 * @param {{ items: any[], analyzingOpen: boolean, complete: boolean }} props
 * @returns {string}
 */
export function footer({ items, analyzingOpen, complete }) {
  const active = items.some((item) =>
    ["queued", "analyzing"].includes(item.analysis?.status),
  );
  const problems = problemSummary(items);
  const problemLabel = active
    ? t("card.pending.title")
    : problemSummaryLabel(problems);
  return html`
    <button
      class="check-timeline__done"
      id="done-check"
      type="button"
      ${complete ? "" : "disabled"}
    >
      ${escapeHtml(t("check.footer.finish"))}
    </button>
    ${items.length
      ? html`
          <button
            class="check-timeline__analyzing"
            id="toggle-analyzing"
            type="button"
            aria-expanded="${analyzingOpen ? "true" : "false"}"
          >
            ${escapeHtml(problemLabel)}
            <span
              class="check-timeline__analyzing-caret ${analyzingOpen
                ? "check-timeline__analyzing-caret--up"
                : ""}"
              aria-hidden="true"
            ></span>
          </button>
        `
      : ""}
  `;
}

export function analyzingSection(
  items,
  sessionCheckId,
  { startedAt = "", siteName = "", siteAddress = "" } = {},
) {
  return analysisResultsTray(items, sessionCheckId, {
    title: "",
    ariaLabel: t("check.analyzing.aria"),
    emptyText: t("analysis.tray.empty"),
    siteName,
    siteAddress,
    checkTime: startedAt,
  });
}

// Shared with <problem-report>, which renders the same grid.
export const shotTile = (item, index) => html`
  <div class="shot">
    <button
      class="shot__preview"
      type="button"
      data-photo-lightbox
      data-photo-address="${escapeAttr(
        item.georeferencedAddress || item.address || item.siteAddress || "",
      )}"
      data-photo-time="${escapeAttr(
        item.uploadedAt || item.createdAt || item.capturedAt || "",
      )}"
    >
      <img
        class="shot__img"
        src="${escapeAttr(item.dataUrl)}"
        alt="${escapeAttr(t("check.photo.alt", { index: index + 1 }))}"
      />
    </button>
    <button
      class="shot__del"
      type="button"
      data-del="${escapeAttr(item.id)}"
      aria-label="${escapeAttr(t("check.photo.delete"))}"
    >
      <wa-icon name="trash" aria-hidden="true"></wa-icon>
    </button>
  </div>
`;

export const addTile = (empty) => html`
  <button
    class="btn-photo photo-capture-tile addshot ${empty
      ? "addshot--empty"
      : ""}"
    id="add-photo"
    type="button"
  >
    <span class="photo-capture-tile__icon addshot__icon" aria-hidden="true"
      ><wa-icon name="camera"></wa-icon
    ></span>
    <span class="photo-capture-tile__label addshot__label"
      >${escapeHtml(t("check.photo.take"))}</span
    >
  </button>
`;
