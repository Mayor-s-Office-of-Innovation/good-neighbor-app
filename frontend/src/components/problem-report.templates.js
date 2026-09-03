import { html } from "../lib/html.js";

export const shell = () => html`
  <div class="flow view-check check">
    <div class="check__bar">
      <button class="check__cancel" id="cancel" type="button">
        <wa-icon name="chevron-left" aria-hidden="true"></wa-icon> Cancel
      </button>
      <span class="check__place">Report a problem</span>
      <span class="check__spacer" aria-hidden="true"></span>
    </div>

    <div
      class="shotgrid"
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

    <dialog
      class="sheet"
      id="cancel-report-dialog"
      aria-label="Leave this report?"
    >
      <div class="sheet__panel">
        <div class="sheet__actions">
          <wa-button
            class="sheet__cancel"
            type="button"
            id="cancel-report-save"
            appearance="outlined"
          >
            Save draft and exit
          </wa-button>
        </div>
        <ul class="sheet__opts">
          <li>
            <wa-button
              class="sheet__opt sheet__opt--danger"
              id="cancel-report-discard"
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
