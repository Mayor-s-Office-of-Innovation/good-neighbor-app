/*
  Presentational templates for <perimeter-check> (5c capture, design port screen 14).
  Pure (data) -> HTML string; all DOM queries, capture wiring, and state live in
  perimeter-check.js. The `html` tag drives editor highlighting + Prettier.

  The design's Voice / Photo / Note trio are plain tiles here; they DRIVE the
  hidden <capture-photo>/<capture-audio> controllers (mounted once, never
  re-rendered) so in-progress recording / file state survives item re-renders.
*/
import { html, escapeHtml } from "../lib/html.js";

/** The one-time shell. Capture controllers are mounted hidden at the end. */
export const shell = ({ siteName, started }) => html`
  <div class="flow view-check">
    <div class="topbar">
      <button class="topbar__back" id="back" type="button" aria-label="Back">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon>
      </button>
      <div class="topbar__titles">
        <h1 class="topbar__title">Evening perimeter check</h1>
        <p class="topbar__sub">
          ${escapeHtml(siteName)} · started ${escapeHtml(started)}
        </p>
      </div>
      <span class="topbar__meta" id="side-progress"></span>
    </div>

    <div class="stepper" id="stepper" aria-label="Perimeter sides"></div>

    <div class="viewfinder">
      <div class="viewfinder__card">
        <h2 id="side-title" class="viewfinder__title"></h2>
        <p id="side-guidance" class="viewfinder__guidance"></p>
      </div>
      <span class="viewfinder__gps">
        <wa-icon name="location-dot" aria-hidden="true"></wa-icon> GPS locked
      </span>
    </div>

    <div class="capture" role="group" aria-label="Capture">
      <button class="capture__tile" id="voice-tile" type="button">
        <span class="capture__box">
          <wa-icon name="microphone" aria-hidden="true"></wa-icon>
        </span>
        <span class="capture__label" id="voice-label">Voice</span>
      </button>
      <button class="capture__tile" id="photo-tile" type="button">
        <span class="capture__box capture__box--photo">
          <wa-icon name="camera" aria-hidden="true"></wa-icon>
        </span>
        <span class="capture__label">Photo</span>
      </button>
      <button class="capture__tile" id="note-tile" type="button">
        <span class="capture__box capture__box--note" aria-hidden="true"
          >T</span
        >
        <span class="capture__label">Note</span>
      </button>
    </div>

    <div class="note-composer" id="note-composer" hidden>
      <wa-textarea
        id="note-input"
        rows="2"
        resize="none"
        placeholder="What a photo won't show…"
      ></wa-textarea>
      <button class="btn-ink btn-ink--sm" id="add-note" type="button">
        Add note
      </button>
    </div>

    <div class="sideitems__head">
      <span class="sideitems__title"
        >On this side · <span id="item-count">0 items</span></span
      >
      <span class="sideitems__hint">Any one type is enough</span>
    </div>
    <ul id="item-list" class="sideitems"></ul>

    <div class="uploadbar" id="uploadbar" hidden>
      <span class="uploadbar__pct" id="upload-pct">61%</span>
      <span class="uploadbar__text"
        >Uploading · analyzed as you go, results at the end</span
      >
    </div>

    <button class="btn-ink" id="next-side" type="button"></button>

    <div class="flow-foot flow-foot--split">
      <button class="flow-foot__link" id="na-side" type="button">
        Can't cover this side
      </button>
      <span>Offline? Queued until signal.</span>
    </div>

    <capture-photo class="visually-hidden" aria-hidden="true"></capture-photo>
    <capture-audio class="visually-hidden" aria-hidden="true"></capture-audio>
  </div>
`;

const KIND_ICON = { photo: "image", voice: "microphone", note: "pen" };
const KIND_LABEL = { photo: "Photo", voice: "Voice note", note: "Note" };
const KIND_SHORT = { photo: "Photo", voice: "Voice", note: "Note" };

/* An item row (photo / voice / note). Photo shows a thumb + Remove; voice shows
   Play (transcribing state in the detail); note shows its text. */
export const itemRow = (item) => {
  let detail, action;
  if (item.kind === "photo") {
    detail = "Uploaded";
    action = "Remove";
  } else if (item.kind === "voice") {
    detail = item.transcript
      ? `“${escapeHtml(item.transcript)}”`
      : "Transcribing…";
    action = "Play";
  } else {
    detail = escapeHtml(item.text || "");
    action = "Remove";
  }

  return html`
    <li class="sideitem" data-id="${item.id}">
      ${item.thumbUrl
        ? html`<img class="sideitem__thumb" src="${item.thumbUrl}" alt="" />`
        : html`<span class="sideitem__icon"
            ><wa-icon
              name="${KIND_ICON[item.kind]}"
              aria-hidden="true"
            ></wa-icon
          ></span>`}
      <div class="sideitem__body">
        <p class="sideitem__title">
          ${KIND_LABEL[item.kind]}${item.kind === "voice" && item.duration
            ? ` · ${escapeHtml(item.duration)}`
            : ""}
        </p>
        <p class="sideitem__detail">${detail}</p>
      </div>
      <button class="sideitem__action" type="button" data-remove="${item.id}">
        ${action}<span class="visually-hidden"> ${KIND_LABEL[item.kind]}</span>
      </button>
    </li>
  `;
};

/* One column of the N/E/S/W stepper. Track color encodes state (done=ink,
   current=blue, todo=grey); the state word below carries the meaning in text. */
export const step = ({ side, current, applicable, items }) => {
  let cls, state;
  if (current) {
    cls = "step--current";
    state = "In progress";
  } else if (!applicable) {
    cls = "step--todo";
    state = "N/A";
  } else if (items.length) {
    cls = "step--done";
    state =
      items.length === 1 ? KIND_SHORT[items[0].kind] : `${items.length} items`;
  } else {
    cls = "step--todo";
    state = "—";
  }
  return html`
    <div class="step ${cls}" ${current ? 'aria-current="step"' : ""}>
      <div class="step__track"></div>
      <div class="step__name">${escapeHtml(side)}</div>
      <div class="step__state">${escapeHtml(state)}</div>
    </div>
  `;
};
