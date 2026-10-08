import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { analysisResultsTray } from "./analysis-results.templates.js";
import { analysisDialogs } from "./analysis-results.templates.js";

export const shell = ({ title = t("problem.title.single") } = {}) => html`
  <div class="flow view-check check check-timeline single-issue">
    <div class="check-timeline__topbar">
      <span aria-hidden="true"></span>
      <button class="check-timeline__close" id="cancel" type="button">
        <span class="check-timeline__close-icon" aria-hidden="true"></span>
        <span class="visually-hidden"
          >${escapeHtml(t("problem.close.aria"))}</span
        >
      </button>
    </div>

    <h1 class="check-timeline__title single-issue__title" tabindex="-1">
      ${escapeHtml(title)}
    </h1>

    <div
      class="shotgrid"
      id="shotgrid"
      aria-label="${escapeAttr(t("problem.grid.aria"))}"
    ></div>

    <button
      class="btn-outline check-roll__describe"
      id="describe-instead"
      type="button"
    >
      ${escapeHtml(t("check.describeInstead"))}
    </button>

    <div class="check-timeline__footer" id="problem-footer"></div>

    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
    />

    <div class="single-issue__analysis" id="single-issue-analysis"></div>

    <dialog
      class="sheet"
      id="cancel-report-dialog"
      aria-label="${escapeAttr(t("problem.cancelDialog.aria"))}"
    >
      <div class="sheet__panel">
        <div class="sheet__actions">
          <button class="sheet__cancel" type="button" id="cancel-report-save">
            ${escapeHtml(t("problem.cancelDialog.save"))}
          </button>
        </div>
        <ul class="sheet__opts">
          <li>
            <button
              class="sheet__opt sheet__opt--danger"
              id="cancel-report-discard"
              type="button"
            >
              ${escapeHtml(t("problem.cancelDialog.discard"))}
            </button>
          </li>
        </ul>
      </div>
    </dialog>
    ${analysisDialogs()}
  </div>
`;

export const analysisSection = (
  items,
  checkId,
  siteName = "",
  siteAddress = "",
) =>
  analysisResultsTray(items, checkId, {
    ariaLabel: t("problem.analysis.aria"),
    emptyText: t("analysis.tray.empty"),
    siteName,
    siteAddress,
  });
