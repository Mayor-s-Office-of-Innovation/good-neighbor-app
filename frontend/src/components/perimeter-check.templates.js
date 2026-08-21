/*
  Presentational templates for <perimeter-check> (5c capture, MVP native-camera port).
  Pure (data) -> HTML string; all DOM queries, file-input wiring, and state live in
  perimeter-check.js. The `html` tag drives editor highlighting + Prettier.

  Capture is a native camera handoff: an ＋ "Add photo" tile triggers a hidden
  <input type="file" accept="image/*" capture="environment">, so users get their
  device's full camera (zoom / focus / flash / lens). Shots for the current side
  render as an inline grid with per-tile delete. Voice + note capture and compass
  side-names are out of the MVP UI (photo-only, numbered sides).
*/
import { html, escapeHtml } from "../lib/html.js";

/** The one-time shell. The Summarising overlay starts hidden. */
export const shell = () => html`
  <div class="flow view-check check">
    <div class="check__bar">
      <button class="check__cancel" id="cancel" type="button">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon> Cancel
      </button>
      <span class="check__side" id="side-progress"></span>
      <button class="check__skip" id="skip-side" type="button">
        Skip side
      </button>
    </div>

    <div class="segbar" id="segbar" aria-label="Perimeter sides"></div>

    <!-- This side's shots (inline grid + a trailing ＋ tile), rendered by JS. -->
    <div class="shotgrid" id="shotgrid" aria-label="Photos for this side"></div>

    <!-- Hidden native-camera handoff: opens the rear camera on phones, the file
         picker on desktop. One photo per invocation. -->
    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      accept="image/*"
      capture="environment"
    />

    <div class="check__actions">
      <button
        class="check__next"
        id="next-side"
        type="button"
        disabled
      ></button>
    </div>

    <!-- AI summary loading state, shown during submit. -->
    <div class="summarising" id="summarising" hidden>
      <p class="summarising__eyebrow">✦ AI SUMMARY</p>
      <wa-spinner class="summarising__spinner"></wa-spinner>
      <p class="summarising__text">Summarising…</p>
    </div>
  </div>
`;

/*
  OPT-IN webcam variant of the shell (behind ?webcam; see services/capture-mode.js).
  Mirrors shell() but swaps the ＋ "Add photo" tile for a persistent inline
  <in-browser-camera> (video + shutter), with the thumbnail grid BELOW it. The
  hidden file input is kept for the denied-camera fallback (host swaps back to the
  ＋ tile via _renderShots). Isolated on purpose so the whole feature is easy to
  remove: delete this template, in-browser-camera.js, and the `_webcam` branch.
*/
export const shellWebcam = () => html`
  <div class="flow view-check check">
    <div class="check__bar">
      <button class="check__cancel" id="cancel" type="button">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon> Cancel
      </button>
      <span class="check__side" id="side-progress"></span>
      <button class="check__skip" id="skip-side" type="button">
        Skip side
      </button>
    </div>

    <div class="segbar" id="segbar" aria-label="Perimeter sides"></div>

    <!-- Persistent live camera: the main element. Mounted once by JS and kept alive
         across captures and sides (never re-rendered, so the stream isn't torn down). -->
    <div class="camera-panel" id="camera-panel"></div>

    <!-- This side's shots, BELOW the camera. Thumbnails only (no ＋ tile) while the
         camera is live; the ＋ tile returns only on the denied-camera fallback. -->
    <div
      class="shotgrid shotgrid--webcam"
      id="shotgrid"
      aria-label="Photos for this side"
    ></div>

    <!-- Kept for the fallback path when the browser camera is unavailable/denied. -->
    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      accept="image/*"
      capture="environment"
    />

    <div class="check__actions">
      <button
        class="check__next"
        id="next-side"
        type="button"
        disabled
      ></button>
    </div>

    <!-- AI summary loading state, shown during submit. -->
    <div class="summarising" id="summarising" hidden>
      <p class="summarising__eyebrow">✦ AI SUMMARY</p>
      <wa-spinner class="summarising__spinner"></wa-spinner>
      <p class="summarising__text">Summarising…</p>
    </div>
  </div>
`;

/*
  One segment of the 4-part progress pill. State is carried by class AND is announced
  to AT via aria-label (color is never the sole carrier):
    captured (>=1 photo) = solid ink · current = ring · skipped = dashed · pending = grey.
*/
export const segment = ({ index, state }) => {
  const label = `Side ${index + 1}: ${state}`;
  return html`<span
    class="seg seg--${state}"
    role="img"
    aria-label="${escapeHtml(label)}"
  ></span>`;
};

/* One captured shot in the grid: the photo + a Delete button. */
export const shotTile = (item) => html`
  <div class="shot">
    <img class="shot__img" src="${item.dataUrl}" alt="" />
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

/*
  The ＋ "Add photo" tile that opens the camera. Empty side → a larger centered tile
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
