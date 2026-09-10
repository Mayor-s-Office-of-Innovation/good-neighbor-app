/*
  Presentational templates for <perimeter-check>.

  The new perimeter flow renders every place in a vertical timeline while each
  photo or typed description analyzes independently.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import {
  analysisResultsTray,
  problemSummary,
  problemSummaryLabel,
} from "./analysis-results.templates.js";

export const shell = ({ embedded = false } = {}) => html`
  <div
    class="flow view-check check check-timeline ${embedded
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
      Take photos at each place.
    </h1>

    <div class="place-timeline" id="place-timeline"></div>

    <div class="check-timeline__footer" id="check-footer"></div>

    <dialog class="places-modal add-place-dialog" id="add-place-dialog">
      <form class="places-modal__card add-place-dialog__panel" method="dialog">
        <div class="places-modal__copy">
          <h2 class="places-modal__title">Add a place</h2>
          <p class="places-modal__text">
            Add a place that isn't already in the list. It will be added to this
            check only.
          </p>
        </div>
        <label class="add-place-dialog__field">
          <span>Place name</span>
          <input
            id="add-place-name"
            type="text"
            autocomplete="off"
            placeholder="Example: Main entrance"
          />
          <small id="add-place-error" role="alert"></small>
        </label>
        <div class="places-modal__actions add-place-dialog__actions">
          <button
            class="btn-ink places-modal__primary"
            id="add-place-submit"
            type="button"
            disabled
          >
            Add place
          </button>
          <button
            class="places-modal__danger add-place-dialog__cancel"
            type="submit"
            value="cancel"
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      class="places-modal done-incomplete-dialog"
      id="done-incomplete-dialog"
      aria-labelledby="done-incomplete-title"
      aria-describedby="done-incomplete-copy"
    >
      <form
        class="places-modal__card done-incomplete-dialog__panel"
        method="dialog"
      >
        <div class="places-modal__copy">
          <h2 class="places-modal__title" id="done-incomplete-title">
            Finish now?
          </h2>
          <p class="places-modal__text" id="done-incomplete-copy"></p>
        </div>
        <div class="places-modal__actions done-incomplete-dialog__actions">
          <button
            class="btn-ink places-modal__primary"
            id="done-incomplete-keep"
            type="submit"
          >
            Keep checking
          </button>
          <button
            class="places-modal__danger"
            id="done-incomplete-finish"
            type="button"
          >
            Finish anyway
          </button>
        </div>
      </form>
    </dialog>

    ${analysisDialogs()}

    <dialog
      class="sheet"
      id="cancel-check-dialog"
      aria-label="Leave this check?"
    >
      <div class="sheet__panel">
        <div class="sheet__actions">
          <wa-button
            class="sheet__cancel"
            type="button"
            id="cancel-check-save"
            appearance="filled"
          >
            Save my place to resume later
          </wa-button>
        </div>
        <ul class="sheet__opts">
          <li>
            <wa-button
              class="sheet__opt sheet__opt--danger"
              id="cancel-check-discard"
              type="button"
              appearance="plain"
            >
              End the check and exit
            </wa-button>
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
 * @param {{ items: Array<{ kind?: string, analysis?: { status?: string } }>, skipped?: boolean }} place
 * @returns {string}
 */
function placeSummary(place) {
  const photoCount = place.items.filter((item) => item.kind === "photo").length;
  const textCount = place.items.filter((item) => item.kind === "text").length;
  const analyzing = place.items.some((item) =>
    ["queued", "analyzing"].includes(item.analysis?.status),
  );
  if (place.skipped) return "Skipped for now";
  const pieces = [];
  if (photoCount) {
    pieces.push(`${photoCount} ${photoCount === 1 ? "photo" : "photos"}`);
  }
  if (textCount) {
    pieces.push(`${textCount} typed note${textCount === 1 ? "" : "s"}`);
  }
  if (analyzing) pieces.push("Analyzing...");
  return pieces.join(" · ");
}

/**
 * @param {object} props
 * @param {{ id: string, name: string, items: any[], skipped?: boolean, inputMode?: string, draftText?: string, conditionLabels?: string[] }} props.place
 * @param {number} props.index
 * @param {boolean} props.expanded
 * @param {boolean} props.isLast
 * @param {string | null} props.openMenuItemId
 * @param {{ top: number, right: number } | null} props.photoMenuAnchor
 * @returns {string}
 */
export function placeRow({
  place,
  index,
  expanded,
  isLast,
  openMenuItemId,
  photoMenuAnchor,
}) {
  const summary = placeSummary(place);
  const complete = place.items.length > 0 || place.skipped;
  return html`
    <section class="place-row ${expanded ? "place-row--expanded" : ""}">
      <div class="place-row__rail" aria-hidden="true">
        <span
          class="place-row__step ${complete ? "place-row__step--done" : ""}"
        >
          ${complete
            ? html`<span class="place-row__check" aria-hidden="true"></span>`
            : index + 1}
        </span>
        <span
          class="place-row__line ${complete
            ? "place-row__line--done"
            : ""} ${isLast ? "place-row__line--short" : ""}"
        ></span>
      </div>
      <div class="place-row__body">
        <button
          class="place-row__header"
          type="button"
          data-toggle-place="${escapeAttr(place.id)}"
          aria-expanded="${expanded ? "true" : "false"}"
        >
          <span>${escapeHtml(place.name)}</span>
          <span
            class="place-row__caret ${expanded ? "place-row__caret--up" : ""}"
            aria-hidden="true"
          ></span>
        </button>
        ${summary
          ? html`<p class="place-row__summary">${escapeHtml(summary)}</p>`
          : ""}
        ${conditionList(place.conditionLabels || [])}
        ${expanded ? expandedPlace(place, openMenuItemId, photoMenuAnchor) : ""}
      </div>
    </section>
  `;
}

function expandedPlace(place, openMenuItemId, photoMenuAnchor) {
  return html`
    <div class="place-row__expanded">
      ${place.inputMode === "text"
        ? textMode(place)
        : photoMode(place, openMenuItemId, photoMenuAnchor)}
    </div>
  `;
}

function photoMode(place, openMenuItemId, photoMenuAnchor) {
  const photos = orderedPhotoItems(place.items);
  const openMenuItem = photos.find((item) => item.id === openMenuItemId);
  return html`
    ${photos.length === 0
      ? html`<p class="place-row__prompt">
          Start with a photo of the whole area.
        </p>`
      : ""}
    <div
      class="perimeter-photos"
      aria-label="Photos for ${escapeAttr(place.name)}"
    >
      ${addPhotoTile(
        photos.length === 0 ? "Take photo" : "Add detail photo",
        place.id,
      )}
      ${photos
        .map((item, index) =>
          photoTile(item, index, openMenuItemId === item.id),
        )
        .join("")}
    </div>
    ${openMenuItem ? photoMenu(openMenuItem, photoMenuAnchor) : ""}
    ${inlineAnalyzing(place)}
    <div class="place-row__actions">
      <button
        class="btn-pill btn-pill--filled"
        type="button"
        data-next-place="${escapeAttr(place.id)}"
      >
        ${place.items.length ? "Next place" : "Skip for now"}
      </button>
      <button
        class="btn-pill btn-pill--outline"
        type="button"
        data-type-place="${escapeAttr(place.id)}"
      >
        Type instead
      </button>
    </div>
  `;
}

export function orderedPhotoItems(items) {
  return items.filter((item) => item.kind === "photo").reverse();
}

function textMode(place) {
  return html`
    <p class="place-row__prompt">
      Describe the whole area, even if there are no problems.
    </p>
    <label class="typed-evidence">
      <span class="visually-hidden"
        >Description for ${escapeHtml(place.name)}</span
      >
      <textarea
        data-text-input="${escapeAttr(place.id)}"
        rows="5"
        placeholder="At ${escapeAttr(place.name)}, ..."
      >
${escapeHtml(place.draftText || "")}</textarea
      >
    </label>
    <div class="place-row__actions">
      <button
        class="btn-pill btn-pill--outline"
        type="button"
        data-photo-place="${escapeAttr(place.id)}"
      >
        Take a photo instead
      </button>
    </div>
  `;
}

function addPhotoTile(label, placeId) {
  return html`
    <button
      class="perimeter-photo perimeter-photo--add"
      type="button"
      data-add-photo="${escapeAttr(placeId)}"
    >
      <span class="perimeter-photo__camera" aria-hidden="true">
        <wa-icon name="camera"></wa-icon>
      </span>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function photoTile(item, index, menuOpen) {
  return html`
    <div class="perimeter-photo perimeter-photo--captured">
      <img
        src="${escapeAttr(item.dataUrl)}"
        alt="Captured photo ${index + 1} for ${escapeAttr(
          item.placeName || "this place",
        )}"
      />
      <button
        class="perimeter-photo__menu-button wa-plain"
        type="button"
        data-photo-menu="${escapeAttr(item.id)}"
        aria-label="Photo options"
        aria-expanded="${menuOpen ? "true" : "false"}"
      >
        <wa-icon name="ellipsis" aria-hidden="true"></wa-icon>
      </button>
    </div>
  `;
}

function photoMenu(item, anchor) {
  const style = anchor
    ? `--photo-menu-top:${anchor.top}px;--photo-menu-right:${anchor.right}px;`
    : "";
  return html`
    <div
      class="photo-menu"
      role="menu"
      aria-label="Photo options"
      style="${escapeAttr(style)}"
    >
      <button
        type="button"
        role="menuitem"
        data-photo-action="note"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="pen-clip" aria-hidden="true"></wa-icon>
        Add note
      </button>
      <button
        type="button"
        role="menuitem"
        data-photo-action="replace"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="repeat" aria-hidden="true"></wa-icon>
        Replace photo
      </button>
      <button
        type="button"
        role="menuitem"
        data-photo-action="move"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="arrow-down" aria-hidden="true"></wa-icon>
        Move to another place
      </button>
      <button
        class="photo-menu__danger"
        type="button"
        role="menuitem"
        data-photo-action="remove"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="trash" aria-hidden="true"></wa-icon>
        Remove photo
      </button>
    </div>
  `;
}

function inlineAnalyzing(place) {
  if (
    !place.items.some((item) =>
      ["queued", "analyzing"].includes(item.analysis?.status),
    )
  ) {
    return "";
  }
  return html`
    <div class="place-row__inline-ai" aria-live="polite">
      <wa-icon name="sparkles" aria-hidden="true"></wa-icon>
      <span></span>
    </div>
  `;
}

function conditionList(labels) {
  if (!labels.length) return "";
  return html`
    <ul class="place-row__conditions">
      ${labels
        .map(
          (label) => html`
            <li>
              <wa-icon name="sparkles" aria-hidden="true"></wa-icon>
              <span>${escapeHtml(label)}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

export function addPlaceButton() {
  return html`
    <button class="place-timeline__add" id="add-place-open" type="button">
      <span class="place-timeline__add-icon" aria-hidden="true"></span>
      <span class="visually-hidden">Add a place</span>
    </button>
  `;
}

export function footer({ items, analyzingOpen }) {
  const active = items.some((item) =>
    ["queued", "analyzing"].includes(item.analysis?.status),
  );
  const problems = problemSummary(items);
  const problemLabel = active ? "Analyzing..." : problemSummaryLabel(problems);
  return html`
    <button class="check-timeline__done" id="done-check" type="button">
      Done
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

export function analyzingSection(items, sessionCheckId) {
  return analysisResultsTray(items, sessionCheckId, {
    ariaLabel: "Analyzing evidence",
    emptyText: "All problems were resolved or deleted.",
  });
}

// Compatibility exports for <problem-report>, which still uses the older grid.
export const shotTile = (item, index) => html`
  <div class="shot">
    <img
      class="shot__img"
      src="${escapeAttr(item.dataUrl)}"
      alt="Captured photo ${index + 1}${item.placeName
        ? ` for ${escapeAttr(item.placeName)}`
        : ""}"
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
