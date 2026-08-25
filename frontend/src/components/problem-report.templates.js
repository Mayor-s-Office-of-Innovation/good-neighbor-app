import { html } from "../lib/html.js";

export const shell = () => html`
  <div class="flow view-check check">
    <div class="check__bar">
      <button class="check__cancel" id="cancel" type="button">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon> Cancel
      </button>
      <span class="check__side">Report a problem</span>
      <span class="check__spacer" aria-hidden="true"></span>
    </div>

    <div class="shotgrid" id="shotgrid" aria-label="Photos for this report"></div>

    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
    />

    <div class="check__actions">
      <button class="check__describe" id="describe-instead" type="button">
        Describe instead
      </button>
      <button class="check__next" id="submit-report" type="button" disabled>
        Submit report
      </button>
    </div>

    <div class="summarising" id="summarising" hidden>
      <p class="summarising__eyebrow">✦ AI SUMMARY</p>
      <wa-spinner class="summarising__spinner"></wa-spinner>
      <p class="summarising__text">Summarising…</p>
    </div>
  </div>
`;

export const shellWebcam = () => html`
  <div class="flow view-check check">
    <div class="check__bar">
      <button class="check__cancel" id="cancel" type="button">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon> Cancel
      </button>
      <span class="check__side">Report a problem</span>
      <span class="check__spacer" aria-hidden="true"></span>
    </div>

    <div class="camera-panel" id="camera-panel"></div>

    <div
      class="shotgrid shotgrid--webcam"
      id="shotgrid"
      aria-label="Photos for this report"
    ></div>

    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
    />

    <div class="check__actions">
      <button class="check__describe" id="describe-instead" type="button">
        Describe instead
      </button>
      <button class="check__next" id="submit-report" type="button" disabled>
        Submit report
      </button>
    </div>

    <div class="summarising" id="summarising" hidden>
      <p class="summarising__eyebrow">✦ AI SUMMARY</p>
      <wa-spinner class="summarising__spinner"></wa-spinner>
      <p class="summarising__text">Summarising…</p>
    </div>
  </div>
`;
