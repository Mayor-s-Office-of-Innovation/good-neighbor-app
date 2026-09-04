/*
  Presentational templates for <perimeter-check> (5c capture, MVP native-camera port).
  Pure (data) -> HTML string; all DOM queries, file-input wiring, and state live in
  perimeter-check.js. The `html` tag drives editor highlighting + Prettier.

  Capture is a native camera handoff: an ＋ "Add photo" tile triggers a hidden
  <input type="file" accept="image/*" capture="environment">, so users get their
  device's full camera (zoom / focus / flash / lens). Shots for the current place
  render as an inline grid with per-tile delete. Voice capture is out of the MVP
  UI; configured place names guide the flow.
*/
import { html, escapeHtml } from "../lib/html.js";

/** The one-time shell. */
export const shell = () => html`
  <div class="flow view-check check">
    <div class="check__bar">
      <button class="check__cancel" id="cancel" type="button">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon> Cancel
      </button>
      <span class="check__place" id="place-progress"></span>
      <button class="check__skip" id="skip-place" type="button">
        Skip place
      </button>
    </div>

    <div class="segbar" id="segbar" aria-label="Perimeter check places"></div>

    <!-- This place's shots (inline grid + a trailing ＋ tile), rendered by JS. -->
    <div
      class="shotgrid"
      id="shotgrid"
      aria-label="Evidence for this place"
    ></div>

    <!-- Hidden native-camera handoff: opens the rear camera on phones, the file
         picker on desktop. One photo per invocation. -->
    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
    />

    <div class="check__actions check__actions--perimeter">
      <div class="check__nav">
        <wa-button
          class="check__previous"
          id="previous-place"
          type="button"
          appearance="filled"
        >
          ‹ Previous place
        </wa-button>
        <button
          class="check__next"
          id="next-place"
          type="button"
          disabled
        ></button>
      </div>
      <button class="check__describe" id="describe-instead" type="button">
        Describe instead
      </button>
    </div>

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
            appearance="outlined"
          >
            Save draft and exit
          </wa-button>
        </div>
        <ul class="sheet__opts">
          <li>
            <wa-button
              class="sheet__opt sheet__opt--danger"
              id="cancel-check-discard"
              type="button"
              appearance="filled"
              variant="danger"
            >
              Discard draft and exit
            </wa-button>
          </li>
        </ul>
      </div>
    </dialog>
  </div>
`;

/*
  One segment of the progress pill. State is carried by class AND is announced
  to AT via aria-label (color is never the sole carrier):
    captured (>=1 photo) = solid ink · current = ring · skipped = dashed · pending = grey.
*/
export const segment = ({ index, state }) => {
  const label = `Place ${index + 1}: ${state}`;
  return html`<span
    class="seg seg--${state}"
    role="img"
    aria-label="${escapeHtml(label)}"
  ></span>`;
};

/* One captured shot in the grid: the photo + a Delete button. */
export const shotTile = (item, index) => html`
  <div class="shot">
    <img
      class="shot__img"
      src="${item.dataUrl}"
      alt="Captured photo ${index + 1}${item.placeName
        ? ` for ${item.placeName}`
        : ""}"
    />
    <button
      class="shot__del"
      type="button"
      data-del="${item.id}"
      aria-label="Delete photo"
    >
      <wa-icon name="trash" aria-hidden="true"></wa-icon>
    </button>
  </div>
`;

export const descriptionTile = ({ placeName }) => html`
  <div class="shot shot--description">
    <button
      class="shot__body shot__body--description"
      type="button"
      data-edit-description="true"
      aria-label="Edit description for ${escapeHtml(placeName)}"
    >
      <span class="shot__icon" aria-hidden="true">
        <wa-icon name="file-lines"></wa-icon>
      </span>
      <span class="shot__label">Description added</span>
    </button>
    <button
      class="shot__del"
      type="button"
      data-del-description="true"
      aria-label="Delete description"
    >
      <wa-icon name="trash" aria-hidden="true"></wa-icon>
    </button>
  </div>
`;

/*
  The ＋ "Add photo" tile that opens the camera. Empty place → a larger centered tile
  with a one-line hint; once shots exist → a compact trailing tile (no hint).
*/
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
