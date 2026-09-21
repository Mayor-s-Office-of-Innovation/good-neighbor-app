/*
  Presentational templates for <perimeter-check>.

  The perimeter check is a flat photo roll (docs/plan-remove-places.md): one
  grid of photos for the whole perimeter, an optional single description as the
  alternative to photos, and a Finish button that unlocks once the completion
  rule in domain/check-completion.js is met. Every photo or description is
  analyzed independently as soon as it is captured.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { MIN_PERIMETER_PHOTOS } from "../domain/check-completion.js";
import {
  analysisResultsTray,
  problemSummary,
  problemSummaryLabel,
} from "./analysis-results.templates.js";

export const shell = ({ embedded = false } = {}) => html`
  <div
    class="flow view-check check check-timeline check-roll ${embedded
      ? "check-timeline--embedded"
      : ""}"
  >
    <div class="check-timeline__topbar">
      <span aria-hidden="true"></span>
      <button class="check-timeline__close" id="cancel" type="button">
        <span class="check-timeline__close-icon" aria-hidden="true"></span>
        <span class="visually-hidden">Close check</span>
      </button>
    </div>

    <h1 class="check-timeline__title" tabindex="-1">
      Take photos around your building.
    </h1>

    <p
      class="check-roll__progress"
      id="check-progress"
      role="status"
      aria-live="polite"
    ></p>

    <div class="check-roll__description" id="check-description"></div>

    <div
      class="shotgrid check-roll__grid"
      id="shotgrid"
      aria-label="Perimeter photos"
    ></div>

    <button
      class="check__describe check-roll__describe"
      id="describe-instead"
      type="button"
    >
      Describe instead
    </button>

    <div class="check-timeline__footer" id="check-footer"></div>

    ${analysisDialogs()}

    <dialog
      class="sheet"
      id="cancel-check-dialog"
      aria-label="Leave this check?"
    >
      <div class="sheet__panel">
        <div class="sheet__actions">
          <button class="sheet__cancel" type="button" id="cancel-check-save">
            Save my place to resume later
          </button>
        </div>
        <ul class="sheet__opts">
          <li>
            <button
              class="sheet__opt sheet__opt--danger"
              id="cancel-check-discard"
              type="button"
            >
              End the check and exit
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

export const analysisDialogs = () => html`
  <dialog
    class="analysis-dialog"
    id="analysis-delete-dialog"
    aria-labelledby="analysis-delete-title"
    aria-describedby="analysis-delete-copy"
  >
    <form class="analysis-dialog__card" method="dialog">
      <div class="analysis-dialog__copy">
        <h2 class="analysis-dialog__title" id="analysis-delete-title"></h2>
        <p class="analysis-dialog__text" id="analysis-delete-copy">
          This action can't be undone. The issue details won't be saved.
        </p>
        <p class="analysis-dialog__error" id="analysis-delete-error" hidden></p>
      </div>
      <div class="analysis-dialog__actions">
        <button
          class="analysis-dialog__button analysis-dialog__button--danger"
          id="analysis-delete-confirm"
          type="button"
        >
          Delete
        </button>
        <button class="analysis-dialog__button" type="submit">Cancel</button>
      </div>
    </form>
  </dialog>

  <dialog
    class="analysis-dialog"
    id="analysis-success-dialog"
    aria-labelledby="analysis-success-title"
    aria-describedby="analysis-success-copy"
  >
    <form class="analysis-dialog__card" method="dialog">
      <div class="analysis-dialog__copy">
        <h2 class="analysis-dialog__title" id="analysis-success-title">
          Great work!
        </h2>
        <p class="analysis-dialog__text" id="analysis-success-copy">
          We've recorded your action. This item is now
          <span>marked as resolved.</span>
        </p>
      </div>
      <div class="analysis-dialog__actions">
        <button
          class="analysis-dialog__button analysis-dialog__button--success"
          type="submit"
        >
          Continue
        </button>
        <button
          class="analysis-dialog__button"
          id="analysis-success-undo"
          type="button"
        >
          Undo
        </button>
      </div>
    </form>
  </dialog>

  <dialog
    class="analysis-dialog"
    id="analysis-progress-dialog"
    aria-labelledby="analysis-progress-title"
  >
    <div class="analysis-dialog__card analysis-dialog__card--progress">
      <h2 class="analysis-dialog__title" id="analysis-progress-title">
        Filing ticket...
      </h2>
      <div class="analysis-progress-ring" aria-hidden="true"></div>
      <button
        class="analysis-dialog__button"
        id="analysis-progress-cancel"
        type="button"
      >
        Cancel
      </button>
    </div>
  </dialog>

  <dialog
    class="analysis-dialog analysis-edit-dialog"
    id="analysis-edit-dialog"
    aria-labelledby="analysis-edit-title"
    aria-describedby="analysis-edit-copy"
  >
    <form class="analysis-dialog__card" method="dialog">
      <div class="analysis-dialog__copy">
        <h2 class="analysis-dialog__title" id="analysis-edit-title">
          Edit problem
        </h2>
        <p class="analysis-dialog__text" id="analysis-edit-copy">
          Change the description to match what you see
        </p>
        <p class="analysis-dialog__error" id="analysis-edit-error" hidden></p>
      </div>
      <label class="analysis-edit-dialog__field">
        <span>Description</span>
        <textarea id="analysis-edit-description" rows="5"></textarea>
      </label>
      <div class="analysis-dialog__actions">
        <button
          class="analysis-dialog__button analysis-dialog__button--ink"
          id="analysis-edit-save"
          type="button"
        >
          Save
        </button>
        <button
          class="analysis-dialog__button analysis-dialog__button--danger-text"
          type="submit"
        >
          Discard
        </button>
      </div>
    </form>
  </dialog>
`;

/**
 * The one-line status under the title. Reads the completion rule so the copy
 * and the Finish button can never disagree.
 * @param {{ photos: number, texts: number, complete: boolean }} status
 * @returns {string}
 */
export function progressLine({ photos, texts, complete }) {
  if (texts > 0) {
    return "<strong>Description saved.</strong> Ready to finish. Photos are optional.";
  }
  if (complete) {
    return `<strong>${photos} photos.</strong> Ready to finish.`;
  }
  return (
    `<strong>${photos} of ${MIN_PERIMETER_PHOTOS} photos.</strong> ` +
    `Take ${MIN_PERIMETER_PHOTOS} photos, or describe the area instead.`
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
    <section class="check-description" aria-label="Your description">
      <p class="check-description__text">${escapeHtml(item.text || "")}</p>
      <div class="check-description__actions">
        <button
          class="check-description__button"
          type="button"
          data-edit-description="${escapeAttr(item.id)}"
        >
          <wa-icon name="pen" aria-hidden="true"></wa-icon>
          Edit
        </button>
        <button
          class="check-description__button check-description__button--danger"
          type="button"
          data-remove-description="${escapeAttr(item.id)}"
        >
          <wa-icon name="trash" aria-hidden="true"></wa-icon>
          Remove
        </button>
      </div>
    </section>
  `;
}

/**
 * The photo roll: captured tiles in capture order, the add tile last.
 * @param {Array<{ id: string, dataUrl?: string }>} photos
 * @returns {string}
 */
export function photoGrid(photos) {
  return (
    photos.map((item, index) => shotTile(item, index)).join("") +
    addTile(photos.length === 0)
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
  const problemLabel = active ? "Analyzing..." : problemSummaryLabel(problems);
  return html`
    <button
      class="check-timeline__done"
      id="done-check"
      type="button"
      ${complete ? "" : "disabled"}
    >
      Finish check
    </button>
    ${items.length
      ? html`
          <button
            class="check-timeline__analyzing"
            id="toggle-analyzing"
            type="button"
            aria-expanded="${analyzingOpen ? "true" : "false"}"
          >
            ${problemLabel}
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

export function analyzingSection(items, sessionCheckId, siteName = "") {
  return analysisResultsTray(items, sessionCheckId, {
    ariaLabel: "Analyzing evidence",
    emptyText: "All problems were resolved or deleted.",
    siteName,
  });
}

// Shared with <problem-report>, which renders the same grid.
export const shotTile = (item, index) => html`
  <div class="shot">
    <img
      class="shot__img"
      src="${escapeAttr(item.dataUrl)}"
      alt="Captured photo ${index + 1}"
    />
    <button
      class="shot__del"
      type="button"
      data-del="${escapeAttr(item.id)}"
      aria-label="Delete photo"
    >
      <wa-icon name="trash" aria-hidden="true"></wa-icon>
    </button>
  </div>
`;

export const addTile = (empty) => html`
  <button
    class="addshot ${empty ? "addshot--empty" : ""}"
    id="add-photo"
    type="button"
  >
    <span class="addshot__label">Add photo</span>
    ${empty
      ? html`<span class="addshot__hint">Tap to open your camera</span>`
      : ""}
  </button>
`;
