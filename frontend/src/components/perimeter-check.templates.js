/*
  Presentational templates for <perimeter-check> (5c capture). Pure (data) -> HTML
  string; all DOM queries, capture wiring, and state live in perimeter-check.js.
  The `html` tag drives editor highlighting + Prettier (see src/lib/html.js).
*/
import { html, escapeHtml } from "../lib/html.js";

/**
     The one-time shell. Capture controls are mounted once and never re-rendered
    (so in-progress recording / file state survives item-list updates).
 */
export const shell = ({ siteName }) => html`
  <div class="stack view-check">
    <header class="check-head">
      <h2>Perimeter check</h2>
      <p class="hint">
        ${escapeHtml(siteName)} · <span id="side-progress"></span>
      </p>
    </header>

    <nav id="side-rail" class="side-rail" aria-label="Perimeter sides"></nav>

    <section class="card side-card">
      <div class="side-card__head">
        <h3 id="side-title" class="side-card__title"></h3>
        <span class="gps"
          ><wa-icon name="location-dot" aria-hidden="true"></wa-icon> GPS
          locked</span
        >
      </div>
      <p id="side-guidance" class="hint"></p>

      <div class="capture-row">
        <capture-photo></capture-photo>
        <capture-audio></capture-audio>
        <div class="stack stack--tight note-field">
          <label for="note-input">Note</label>
          <wa-textarea
            id="note-input"
            rows="2"
            resize="none"
            placeholder="What a photo won't show…"
          ></wa-textarea>
          <wa-button
            id="add-note"
            type="button"
            appearance="outlined"
            size="small"
          >
            <wa-icon slot="start" name="pen" aria-hidden="true"></wa-icon> Add
            note
          </wa-button>
        </div>
      </div>
    </section>

    <section class="card">
      <h3 class="items__head">
        On this side · <span id="item-count">0 items</span>
      </h3>
      <p class="hint">
        Any one type is enough. Analyzed as you go — results at the end.
      </p>
      <ul id="item-list" class="items"></ul>
    </section>

    <div class="check-actions">
      <wa-button id="na-side" type="button" appearance="plain"
        >Can't cover this side</wa-button
      >
      <wa-button
        id="next-side"
        variant="neutral"
        appearance="accent"
        class="cta"
      ></wa-button>
    </div>
  </div>
`;

const KIND_ICON = { photo: "image", voice: "microphone", note: "pen" };
const KIND_LABEL = { photo: "Photo", voice: "Voice note", note: "Note" };

export const itemRow = (item) => {
  let detail;
  if (item.kind === "photo") detail = "Uploaded";
  else if (item.kind === "voice")
    detail = item.transcript
      ? `“${escapeHtml(item.transcript)}”`
      : "Transcribing…";
  else detail = escapeHtml(item.text || "");

  return html`
    <li class="item" data-id="${item.id}">
      ${item.thumbUrl
        ? html`<img class="item__thumb" src="${item.thumbUrl}" alt="" />`
        : html`<wa-icon
            class="item__icon"
            name="${KIND_ICON[item.kind]}"
            aria-hidden="true"
          ></wa-icon>`}
      <div class="item__body">
        <p class="item__title">${KIND_LABEL[item.kind]}</p>
        <p class="hint item__detail">${detail}</p>
      </div>
      <wa-button
        class="item__remove"
        type="button"
        appearance="plain"
        size="small"
        data-remove="${item.id}"
      >
        <wa-icon name="trash" aria-hidden="true"></wa-icon>
        <span class="visually-hidden">Remove ${KIND_LABEL[item.kind]}</span>
      </wa-button>
    </li>
  `;
};

export const railItem = ({ side, current, applicable, count }) => {
  let state;
  if (!applicable) state = "N/A";
  else if (current) state = "In progress";
  else if (count > 0) state = `${count}`;
  else state = "—";
  return html`
    <span
      class="rail__side ${current ? "is-current" : ""} ${!applicable
        ? "is-na"
        : ""}"
      ${current ? 'aria-current="step"' : ""}
    >
      <span class="rail__name">${escapeHtml(side)}</span>
      <span class="rail__state">${state}</span>
    </span>
  `;
};
