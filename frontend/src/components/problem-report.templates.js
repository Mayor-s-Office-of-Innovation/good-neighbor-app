import { captureClose } from "./perimeter-check.templates.js";
import { captureControls } from "./capture-controls.templates.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import { analysisResultsTray } from "./analysis-results.templates.js";
import { analysisDialogs } from "./analysis-results.templates.js";

export const shell = ({ title = t("problem.title.single") } = {}) => html`
  <div class="flow view-check check check-timeline single-issue">
    ${captureClose(t("problem.close.aria"))}

    <h1 class="check-timeline__title single-issue__title" tabindex="-1">
      ${escapeHtml(title)}
    </h1>

    ${captureControls({ cameraId: "add-photo", textId: "describe-instead" })}
    <input
      type="file"
      id="gallery-input"
      class="capture-picker"
      accept="image/*"
      multiple
      hidden
    />

    <div
      class="shotgrid check-roll__grid"
      id="shotgrid"
      aria-label="${escapeAttr(t("problem.grid.aria"))}"
    ></div>

    <div
      class="capture-labels"
      id="capture-labels"
      role="status"
      aria-live="polite"
    ></div>

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
    flowType: "single-problem",
    ariaLabel: t("problem.analysis.aria"),
    emptyText: t("analysis.tray.empty"),
    siteName,
    siteAddress,
  });
