import { html, escapeHtml } from "../lib/html.js";
import { analysisResultsTray } from "./analysis-results.templates.js";
import { analysisDialogs } from "./perimeter-check.templates.js";

export const shell = ({
  embedded = false,
  title = "Flag a single issue",
} = {}) => html`
  <div
    class="flow view-check check single-issue ${embedded
      ? "check--embedded"
      : ""}"
  >
    <div class="check-timeline__topbar">
      <span aria-hidden="true"></span>
      <button class="check-timeline__close" id="cancel" type="button">
        <span class="check-timeline__close-icon" aria-hidden="true"></span>
        <span class="visually-hidden">Close report</span>
      </button>
    </div>

    <h1 class="single-issue__title" tabindex="-1">${escapeHtml(title)}</h1>

    <div
      class="shotgrid"
      id="shotgrid"
      aria-label="Photos for this report"
    ></div>

    <button
      class="check__describe single-issue__describe"
      id="describe-instead"
      type="button"
    >
      Describe instead
    </button>

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
      <button class="check__next" id="submit-report" type="button">Done</button>
    </div>

    <div class="single-issue__analysis" id="single-issue-analysis"></div>

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
    ${analysisDialogs()}
  </div>
`;

export const analysisSection = (items, checkId) =>
  analysisResultsTray(items, checkId, {
    ariaLabel: "Single issue analysis results",
    emptyText: "All problems were resolved or deleted.",
  });
