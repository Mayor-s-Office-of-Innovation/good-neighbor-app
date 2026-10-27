import { artifactPhoto } from "./artifact-photo.templates.js";
import { taskArtifactIds } from "../domain/home-tasks.js";
import { statusTickerMarkup } from "./status-ticker.js";
import { duplicateUiEnabled } from "../services/feature-flags.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";
import { t } from "../i18n/i18n.js";
import {
  formatMonthDay,
  formatMonthDayTime,
  formatTime,
  pacificDaysAgo,
} from "../i18n/dates.js";
import { localizedAnalyzerText } from "../i18n/analyzer.js";
import { rulebookText } from "../i18n/rulebook.js";
import { taskMediaUrl } from "../domain/task-media.js";
import { taskRoute } from "../domain/task-route.js";
import "./duplicate-issue.css";
/** @param {Record<string,any>} task */
export const duplicateTitle = (task) =>
  localizedAnalyzerText(
    task,
    task.userFriendlyLabel || task.user_friendly_label || "",
    "user_friendly_label",
  ) ||
  rulebookText(task.analyzerCategory || task.category) ||
  t("card.title.fallback");
/** @param {Record<string,any>} task */
export const issueReference = (task) =>
  String(task.shortId || task.taskId || "").replace(/^#/, "");
/** @param {Record<string,any>} task */
export function duplicateCard(task) {
  const original = task.duplicate.original,
    image = taskMediaUrl(task);
  return html`<article
    class="analysis-card duplicate-card"
    data-task-id="${escapeAttr(task.taskId)}"
    data-check-id="${escapeAttr(task.checkId)}"
    data-condition-id="${escapeAttr(task.conditionId)}"
  >
    <button
      type="button"
      class="btn-card duplicate-card__body"
      data-action="duplicate"
      data-analysis-action="duplicate"
    >
      ${image || task.evidence?.kind === "photo"
        ? artifactPhoto({
            className: "duplicate-card__image",
            src: image,
            original: task.mediaUrl,
            checkId: task.checkId,
            artifactId: taskArtifactIds(task)[0],
            alt: duplicateTitle(task),
          })
        : html`<span class="duplicate-card__image duplicate-card__placeholder"
            ><wa-icon name="image" aria-hidden="true"></wa-icon
          ></span>`}
      <span class="duplicate-card__copy"
        >${statusTickerMarkup(task)}<span class="duplicate-card__title"
          >${escapeHtml(duplicateTitle(task))}</span
        ><span
          >${escapeHtml(
            t("duplicate.added", {
              reference: issueReference(original),
              date: formatMonthDay(original.createdAt),
            }),
          )}</span
        ></span
      >
      <wa-icon name="chevron-right" aria-hidden="true"></wa-icon>
    </button>
    <footer>
      <time datetime="${escapeAttr(task.createdAt)}"
        >${escapeHtml(
          pacificDaysAgo(task.createdAt) === 0
            ? t("card.time.today", { time: formatTime(task.createdAt) })
            : t("card.time.date", {
                date: formatMonthDay(task.createdAt),
                time: formatTime(task.createdAt),
              }),
        )}</time
      ><span>${escapeHtml(issueReference(task))}</span>
    </footer>
  </article>`;
}
/** @param {Record<string,any>} task @param {string} image @param {boolean} busy @param {string} error */
export function duplicateDetail(task, image, busy, error) {
  const original = task.duplicate.original,
    route = taskRoute(original);
  return html`<dialog
    class="duplicate-detail"
    aria-labelledby="duplicate-title"
  >
    <section class="duplicate-detail__sheet">
      <div class="duplicate-detail__close">
        <button
          type="button"
          class="btn-icon"
          data-duplicate-close
          aria-label="${escapeAttr(t("common.close"))}"
        >
          <img src="/duplicate-assets/close.svg" alt="" />
        </button>
      </div>
      <p class="duplicate-detail__route">
        ${route.tone === "311"
          ? html`<img src="/duplicate-assets/dot.svg" alt="" />`
          : html`<span
              class="analysis-card__route-dot"
              aria-hidden="true"
            ></span>`}
        ${escapeHtml(route.label)} ·
        <strong
          >${escapeHtml(
            t(
              original.status === "open"
                ? "duplicate.status"
                : "duplicate.alreadyReported",
            ),
          )}</strong
        >
      </p>
      <header>
        <p>
          ${escapeHtml(task.georeferencedAddress || task.siteAddress || "")}
        </p>
        <h2 id="duplicate-title">${escapeHtml(duplicateTitle(task))}</h2>
        <p>${escapeHtml(formatMonthDayTime(task.createdAt))}</p>
      </header>
      ${image || task.evidence?.kind === "photo"
        ? artifactPhoto({
            className: "duplicate-detail__image",
            src: image,
            original: task.mediaUrl,
            checkId: task.checkId,
            artifactId: taskArtifactIds(task)[0],
            alt: duplicateTitle(task),
          })
        : ""}
      <p class="duplicate-detail__description">
        ${escapeHtml(
          localizedAnalyzerText(task, task.description || "", "description"),
        )}
      </p>
      <section class="duplicate-detail__link">
        <p>
          <img src="/duplicate-assets/clone.svg" alt="" />${escapeHtml(
            t("duplicate.addedShort"),
          )}
        </p>
        <button
          type="button"
          class="btn-card duplicate-detail__original"
          data-duplicate-original
        >
          <span
            ><strong>#${escapeHtml(issueReference(original))}</strong
            ><span
              >${escapeHtml(
                t("duplicate.originalSummary", {
                  label: duplicateTitle(original),
                  date: formatMonthDay(original.createdAt),
                }),
              )}</span
            ></span
          ><img src="/duplicate-assets/chevron.svg" alt="" />
        </button>
        <button
          type="button"
          class="btn-outline"
          data-duplicate-separate
          ${busy ? 'disabled aria-busy="true"' : ""}
        >
          ${escapeHtml(t("duplicate.notDuplicate"))}
        </button>
        ${error ? html`<p role="alert">${escapeHtml(error)}</p>` : ""}
      </section>
    </section>
  </dialog>`;
}

/** @param {{newCount:number,duplicateCount:number}} counts */
export function duplicateCountLabel(counts) {
  if (!duplicateUiEnabled()) return "";
  return html`<p class="analysis-tray__counts">
    ${escapeHtml(
      counts.duplicateCount
        ? t("duplicate.counts", {
            newCount: counts.newCount,
            duplicateCount: counts.duplicateCount,
          })
        : t("duplicate.newCount", { count: counts.newCount }),
    )}
  </p>`;
}
