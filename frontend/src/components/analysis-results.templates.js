import { pendingDeletedConditionIds } from "../state/pending-deletions.js";
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

const CLEAR_CHECK_ICON = "/clear-check-icon.png";

/**
 * @typedef {object} AnalysisCondition
 * @property {string} [conditionId]
 * @property {string} [category]
 * @property {string} [analyzerCategory]
 * @property {string} [canonicalCategory]
 * @property {string} [userFriendlyLabel]
 * @property {string} [user_friendly_label]
 * @property {string} [description]
 * @property {{ key?: string, prompt?: string, options?: { label?: string, value?: boolean }[] } | null} [needsAnswer]
 */

/**
 * @typedef {object} AnalysisTask
 * @property {string} [taskId]
 * @property {string} [shortId]
 * @property {string} [displayId]
 * @property {string} [display_id]
 * @property {string} [assessmentId]
 * @property {string} [conditionId]
 * @property {string} [category]
 * @property {string} [analyzerCategory]
 * @property {string} [userFriendlyLabel]
 * @property {string} [user_friendly_label]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [guidance]
 * @property {string} [kind]
 * @property {string[]} [buttons]
 * @property {Array<{ code?: string, payload?: { phoneNumber?: string } }>} [appActions]
 * @property {string} [createdAt]
 * @property {string} [created_at]
 */

/**
 * @typedef {object} AnalysisSource
 * @property {string} [analysisId]
 */

/**
 * @typedef {object} AnalysisAssessment
 * @property {string} [assessmentId]
 */

/**
 * @typedef {{ uploaded?: string, sent?: string, waiting?: string }} AnalysisStages
 */

/**
 * @typedef {object} AnalysisState
 * @property {string} [status]
 * @property {string} [artifactId]
 * @property {string} [checkId]
 * @property {AnalysisAssessment} [assessment]
 * @property {AnalysisSource} [sourceAnalysis]
 * @property {AnalysisTask[]} [tasks]
 * @property {AnalysisCondition[]} [conditions]
 * @property {string[]} [resolvedConditionIds]
 * @property {string[]} [rejectedConditionIds]
 * @property {boolean} [hideNoIssuesCard]
 * @property {string} [noIssuesDescription]
 * @property {string} [error]
 * @property {AnalysisStages} [stages] progress checkpoints (uploaded / sent ISO stamps)
 * @property {{ leg?: string, uploaded?: boolean, enqueued?: boolean, waitedMs?: number, backendError?: boolean }} [failure]
 */

/**
 * @typedef {object} AnalysisItem
 * @property {string} [id]
 * @property {"photo" | "text" | string} [kind]
 * @property {string} [dataUrl]
 * @property {string} [text]
 * @property {string} [placeName] label under the evidence preview; legacy items
 *   carry a place name, current items are labeled with the site name by the host
 * @property {string} [georeferencedAddress]
 * @property {string} [address]
 * @property {string} [siteAddress]
 * @property {string} [uploadedAt]
 * @property {string} [createdAt]
 * @property {string} [checkId]
 * @property {AnalysisState} [analysis]
 * @property {{ artifactId?: string }} [upload]
 */

/**
 * @typedef {object} TaskEvidence
 * @property {string} [artifactId]
 * @property {string} [placeName]
 * @property {string} [text]
 */

/**
 * @typedef {object} HomeTask
 * @property {string} [taskId]
 * @property {string} [shortId]
 * @property {string} [displayId]
 * @property {string} [display_id]
 * @property {string} [conditionId]
 * @property {string} [checkId]
 * @property {string} [assessmentId]
 * @property {string} [category]
 * @property {string} [analyzerCategory]
 * @property {string} [userFriendlyLabel]
 * @property {string} [user_friendly_label]
 * @property {string} [label]
 * @property {string} [description]
 * @property {string} [guidance]
 * @property {string} [kind]
 * @property {string} [thumbnailUrl]
 * @property {string} [thumbUrl]
 * @property {string} [mediaUrl]
 * @property {string} [photoUrl]
 * @property {string} [imageUrl]
 * @property {string} [placeName]
 * @property {string} [location]
 * @property {string} [text]
 * @property {string[]} [sourceArtifactIds]
 * @property {TaskEvidence} [evidence]
 * @property {string[]} [buttons]
 * @property {Array<{ code?: string, payload?: { phoneNumber?: string } }>} [appActions]
 * @property {string} [createdAt]
 * @property {string} [created_at]
 * @property {string} [georeferencedAddress]
 * @property {string} [address]
 * @property {string} [siteAddress]
 */

/**
 * @typedef {object} CardAction
 * @property {string} [label]
 * @property {string} [variant]
 * @property {string} [kind]
 */

/**
 * @typedef {object} TrayOptions
 * @property {string} [id]
 * @property {string} [title]
 * @property {string} [ariaLabel]
 * @property {string} [emptyText]
 * @property {string} [tone]
 * @property {string} [footer]
 * @property {string} [siteName] label for evidence previews that carry no place name
 * @property {string} [siteAddress] fallback address for current evidence
 * @property {string} [checkTime]
 * @property {AnalysisCardEntry[]} [extraCards]
 */

/**
 * @typedef {{ markup: string, createdAt?: string, needsAnswer?: boolean, isClear?: boolean, actionPriority?: number }} AnalysisCardEntry
 */

/** Lower ranks appear first: emergency, non-emergency, 311, on-site. */
export function analysisActionPriority(task) {
  switch (routeType(task).tone) {
    case "emergency":
      return 0;
    case "non-emergency":
      return 1;
    case "311":
      return 2;
    default:
      return 3;
  }
}

/** @param {AnalysisCardEntry[]} cards */
export function sortAnalysisCards(cards) {
  return [...cards].sort(
    (a, b) =>
      Number(Boolean(b.needsAnswer)) - Number(Boolean(a.needsAnswer)) ||
      (a.actionPriority ?? 4) - (b.actionPriority ?? 4) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")),
  );
}

/**
 * @typedef {object} ProblemSummary
 * @property {number} visible
 * @property {number} hidden
 */

/**
 * @typedef {object} VisibleProblemSelection
 * @property {Set<string>} hiddenConditionIds
 * @property {AnalysisTask[]} visibleTasks
 * @property {AnalysisCondition[]} visibleConditions
 */

/**
 * @param {AnalysisItem[]} items
 * @param {string} sessionCheckId
 * @param {TrayOptions} [options]
 * @returns {string}
 */
export function analysisResultsTray(
  items,
  sessionCheckId,
  {
    id = "analysis-tray",
    title = "Analysis results",
    ariaLabel = "Analysis results",
    emptyText = "All problems were resolved or deleted.",
    tone = "new",
    footer = "",
    siteName = "",
    siteAddress = "",
    checkTime = "",
    extraCards = [],
  } = {},
) {
  const summary = problemSummary(items);
  let clearCardRendered = false;
  const cards = sortAnalysisCards([
    ...items.flatMap((item) =>
      analysisCardEntries(item, sessionCheckId, { siteName, siteAddress }).filter((card) => {
        if (!card.isClear) return true;
        if (
          summary.visible > 0 ||
          summary.hidden > 0 ||
          extraCards.length > 0 ||
          clearCardRendered
        ) {
          return false;
        }
        clearCardRendered = true;
        return true;
      }),
    ),
    ...extraCards,
  ]);
  return html`
    <section
      class="analysis-tray analysis-tray--${escapeAttr(tone)} ${checkTime
        ? "analysis-tray--recent"
        : ""}"
      id="${escapeAttr(id)}"
      aria-label="${escapeAttr(ariaLabel)}"
    >
      ${title ? html`<h2>${escapeHtml(title)}</h2>` : ""}
      ${cards.length
        ? html`<div class="analysis-tray__cards">
            ${checkTime
              ? html`<h2 class="analysis-tray__check-title">
                  ${escapeHtml(recentCheckTitle(checkTime))}
                </h2>`
              : ""}
            ${cards.map((card) => card.markup).join("")}${footer}
          </div>`
        : summary.hidden > 0
          ? html`<p class="analysis-tray__empty">${escapeHtml(emptyText)}</p>`
          : ""}
    </section>
  `;
}

export function recentCheckTitle(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "From today's check";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const day =
    date.toDateString() === today.toDateString()
      ? "today's"
      : date.toDateString() === yesterday.toDateString()
        ? "yesterday's"
        : `${new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
          }).format(date)}'s`;
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `From ${day} ${time} check`;
}

export function historicalCheckTitle(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "From an earlier check";
  if (date.toDateString() === now.toDateString()) {
    const time = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
    return `From today's ${time} check`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "From yesterday's check";
  }
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(now.getDate() - now.getDay());
  if (date >= weekStart && date < now) {
    const weekday = new Intl.DateTimeFormat(undefined, {
      weekday: "long",
    }).format(date);
    return `From ${weekday}'s check`;
  }
  return `From the check on ${new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  }).format(date)}`;
}

/**
 * @param {AnalysisItem} evidence
 * @param {string} sessionCheckId
 * @param {{ siteName?: string, siteAddress?: string }} [options]
 * @returns {string[]}
 */
export function analysisCards(item, sessionCheckId, options = {}) {
  return analysisCardEntries(item, sessionCheckId, options).map((card) => card.markup);
}

/**
 * @param {AnalysisItem} evidence
 * @param {string} sessionCheckId
 * @param {{ siteName?: string, siteAddress?: string }} [options]
 * @returns {AnalysisCardEntry[]}
 */
function analysisCardEntries(evidence, sessionCheckId, { siteName = "", siteAddress = "" } = {}) {
  const item = {
    ...evidence,
    placeName: evidence.placeName || siteName,
    siteAddress: evidence.siteAddress || siteAddress,
  };
  const status = item.analysis?.status || "idle";
  const itemTime = item.uploadedAt || item.createdAt || "";
  if (status === "failed") {
    return [{ markup: failedCard(item), createdAt: itemTime }];
  }
  if (status !== "analyzed") {
    return [{ markup: pendingCard(item), createdAt: itemTime }];
  }
  const { hiddenConditionIds, visibleTasks, visibleConditions } =
    visibleProblemSelection(item);
  if (!visibleTasks.length && !visibleConditions.length) {
    if (hiddenConditionIds.size || item.analysis?.hideNoIssuesCard) return [];
    return [{ markup: clearCheckCard(), createdAt: itemTime, isClear: true }];
  }
  if (visibleTasks.length) {
    const taskConditionIds = new Set(
      visibleTasks.map((task) => task.conditionId).filter(Boolean),
    );
    const unpairedConditions = visibleConditions.filter(
      (condition) => !taskConditionIds.has(condition.conditionId),
    );
    const taskCards = visibleTasks.map((task) => {
      const condition =
        visibleConditions.find(
          (candidate) =>
            task.conditionId && candidate.conditionId === task.conditionId,
        ) || {};
      const createdAt = task.createdAt || task.created_at || itemTime;
      return {
        markup: completedEvidenceCard(item, sessionCheckId, {
          title:
            displayCategory(task) ||
            displayCategory(condition) ||
            "Condition found",
          description:
            task.guidance || condition.description || "Review this condition.",
          action: taskButtonLabel(task) || actionLabel(task.kind),
          actionKind: task.kind || "",
          routeType: routeType(task),
          taskId: task.taskId || "",
          conditionId: task.conditionId || condition.conditionId || "",
          metaLabel: newTaskMetaLabel(task),
          createdAt,
          shortId: taskDisplayReference(task),
        }),
        createdAt,
        needsAnswer: Boolean(condition.needsAnswer),
        actionPriority: analysisActionPriority(task),
      };
    });
    return [
      ...taskCards,
      ...unpairedConditions.map((condition) => ({
        markup: conditionEvidenceCard(item, sessionCheckId, condition),
        createdAt: itemTime,
        needsAnswer: Boolean(condition.needsAnswer),
      })),
    ];
  }
  return visibleConditions.map((condition) => ({
    markup: conditionEvidenceCard(item, sessionCheckId, condition),
    createdAt: itemTime,
    needsAnswer: Boolean(condition.needsAnswer),
  }));
}

export function clearCheckCard() {
  return html`
    <article class="analysis-card analysis-card--clear">
      <div class="analysis-card__panel">
        <div class="analysis-card__clear-title">
          <img src="${escapeAttr(CLEAR_CHECK_ICON)}" alt="" />
          <h3>Your check was clear!</h3>
        </div>
        <p class="analysis-card__clear-copy">
          We didn't identify any perimeter issues in this check.
          <a href="/problem">Add a problem</a> if we missed something
        </p>
      </div>
    </article>
  `;
}

/**
 * @param {AnalysisItem} item
 * @param {string} sessionCheckId
 * @param {AnalysisCondition} condition
 * @returns {string}
 */
function conditionEvidenceCard(item, sessionCheckId, condition) {
  return completedEvidenceCard(item, sessionCheckId, {
    title: condition.needsAnswer
      ? "More details needed"
      : displayCategory(condition) || "Condition found",
    description: condition.description || "Review this condition.",
    action: "",
    actionKind: "",
    conditionId: condition.conditionId || "",
    question: condition.needsAnswer,
  });
}

/**
 * @param {object} params
 * @param {HomeTask} params.task
 * @param {CardAction | null} params.action
 * @param {string} params.statusLabel
 * @param {boolean} [params.isNew]
 * @param {boolean} [params.includeControls]
 * @param {string} [params.siteName] caption when the task's evidence has no place name
 * @returns {string}
 */
export function taskAnalysisCard({
  task,
  action,
  statusLabel,
  isNew = false,
  includeControls = true,
  siteName = "",
}) {
  const mediaUrl =
    task.thumbnailUrl ||
    task.thumbUrl ||
    task.mediaUrl ||
    task.photoUrl ||
    task.imageUrl ||
    "";
  // `positionDescriptor` is deliberately not a fallback: since ADR 0014 it is
  // a fixed literal, not a location.
  const placeName =
    task.evidence?.placeName || task.placeName || task.location || "";
  const evidenceText = task.evidence?.text || task.text || "";
  const pseudoItem = {
    id: task.taskId || "",
    kind: mediaUrl ? "photo" : "text",
    dataUrl: mediaUrl,
    text: evidenceText,
    placeName: placeName || siteName || "Site",
    georeferencedAddress: task.georeferencedAddress || "",
    address: task.address || "",
    siteAddress: task.siteAddress || "",
    checkId: task.checkId || "",
    analysis: {
      artifactId: taskArtifactId(task),
      assessment: {},
      sourceAnalysis: {},
    },
  };
  return completedEvidenceCard(pseudoItem, task.checkId || "", {
    title: displayCategory(task) || task.label || "Condition found",
    description: task.guidance || task.description || task.category || "",
    editableDescription: task.description || "",
    action: includeControls ? action?.label || "Done" : "",
    actionKind:
      task.kind || (action?.variant === "blue" ? "escalation" : "action"),
    taskId: task.taskId || "",
    conditionId: task.conditionId || "",
    metaLabel: statusLabel || taskMetaLabel(task, isNew),
    actionAttribute: "data-action",
    actionValue: action?.kind || "done",
    includeEditDelete: includeControls,
    isNew,
    routeType: routeType(task),
    createdAt: task.createdAt || task.created_at || "",
    shortId: taskDisplayReference(task),
  });
}

/**
 * @param {AnalysisTask | HomeTask} task
 * @returns {string}
 */
function taskDisplayReference(task) {
  return String(
    task.shortId ||
      task.displayId ||
      task.display_id ||
      task.assessmentId ||
      "",
  );
}

/**
 * @param {AnalysisTask | HomeTask} task
 * @returns {string}
 */
function newTaskMetaLabel(task) {
  const reference = taskDisplayReference(task);
  return reference ? `NEW • ${reference}` : "NEW";
}

/**
 * @param {HomeTask} task
 * @param {boolean} isNew
 * @returns {string}
 */
function taskMetaLabel(task, isNew) {
  if (isNew) return newTaskMetaLabel(task);
  const reference = taskDisplayReference(task);
  return reference ? `NEEDS ACTION • ${reference}` : "NEEDS ACTION";
}

function pendingCard(item) {
  const place = cardPlace(item);
  return html`
    <article class="analysis-card analysis-card--pending analysis-card--new">
      <div class="analysis-card__panel">
        <span
          class="analysis-card__skeleton analysis-card__skeleton--route"
          aria-hidden="true"
        ></span>
        <div class="analysis-card__layout">
          <div class="analysis-card__content">
            <p class="analysis-card__place">${escapeHtml(place || "Place")}</p>
            <h3>Analyzing...</h3>
            <div class="analysis-card__skeleton-copy" aria-hidden="true">
              <span
                class="analysis-card__skeleton analysis-card__skeleton--wide"
              ></span>
              <span
                class="analysis-card__skeleton analysis-card__skeleton--mid"
              ></span>
            </div>
            <span
              class="analysis-card__skeleton analysis-card__skeleton--button"
              aria-hidden="true"
            ></span>
          </div>
          ${evidencePreview(item, true)}
        </div>
      </div>
    </article>
  `;
}

/**
 * One progress row. The state is IN THE TEXT ("Done"/"In progress") so screen
 * readers hear it — the ✓/• glyph is decoration (aria-hidden) and never the
 * sole carrier.
 * @param {string} label
 * @param {string | undefined} stamp stage timestamp (set = done)
 * @param {boolean} reached has the pipeline reached this stage (vs skipped by an early failure)
 * @returns {string}
 */
function stageRow(label, stamp, reached) {
  return html`
    <li
      class="analysis-card__stage ${stamp
        ? "is-done"
        : reached
          ? "is-active"
          : ""}"
    >
      <span class="analysis-card__stage-mark" aria-hidden="true"
        >${stamp ? "✓" : "•"}</span
      >
      <span class="visually-hidden">${stamp ? "Done. " : "In progress. "}</span>
      <span>${escapeHtml(label)}</span>
    </li>
  `;
}

/**
 * A failed card: what happened, what had already succeeded, how long we
 * waited, and a Try-again button. Un-uploaded photos also offer Remove.
 * @param {AnalysisItem} item
 * @returns {string}
 */
function failedCard(item) {
  const failure = item.analysis?.failure || {};
  const stages = item.analysis?.stages || {};
  const uploaded = Boolean(failure.uploaded || stages.uploaded);
  const waited = formatWaited(failure.waitedMs);
  const sent = uploaded && failure.leg !== "upload";
  const reason = failureReasonLine(failure, item);
  return html`
    <article
      class="analysis-card analysis-card--failed analysis-card--new"
      data-item-id="${escapeAttr(item.id || "")}"
    >
      <div class="analysis-card__content">
        <p class="analysis-card__meta">
          <img
            class="analysis-card__star"
            src="/icons/star.svg"
            alt=""
            aria-hidden="true"
          />
          COULDN'T FINISH
        </p>
        <h3>
          ${failure.leg === "upload"
            ? "Upload failed"
            : "Analysis didn't finish"}
        </h3>
        <ul class="analysis-card__stages">
          ${stageRow(
            item.kind === "text" ? "Note saved" : "Photo uploaded",
            uploaded ? new Date().toISOString() : "",
            true,
          )}
          ${stageRow(
            "Sent to analyzer",
            sent ? new Date().toISOString() : "",
            uploaded,
          )}
        </ul>
        <p class="analysis-card__failure-reason">
          ${escapeHtml(reason)}${waited
            ? html` Waited ${escapeHtml(waited)}.`
            : ""}
        </p>
        <div class="analysis-card__actions">
          <button
            class="analysis-card__primary wa-plain"
            type="button"
            data-analysis-action="retry"
          >
            <wa-icon name="arrow-rotate-right" aria-hidden="true"></wa-icon>
            Try again
          </button>
          ${item.kind === "photo" && !uploaded
            ? html`<button
                class="analysis-card__icon analysis-card__icon--danger wa-plain"
                type="button"
                aria-label="Remove photo"
                data-analysis-action="remove-item"
              >
                <wa-icon name="trash" aria-hidden="true"></wa-icon>
              </button>`
            : ""}
        </div>
      </div>
      ${evidencePreview(item)}
    </article>
  `;
}

/**
 * Human line for the failing leg, naming what to do next. Every string names
 * both the step that failed and what to do — no two failure modes read alike.
 * @param {{ leg?: string, backendError?: boolean }} failure
 * @param {AnalysisItem} item
 * @returns {string}
 */
function failureReasonLine(failure, item) {
  switch (failure.leg) {
    case "upload":
      return "We couldn't reach the server to upload. Check your connection and try again.";
    case "analyze":
      return failure.backendError
        ? "The analysis service couldn't process this one."
        : item.kind === "text"
          ? "The analysis is taking longer than expected."
          : "The analysis is taking longer than expected. Your photo is saved — trying again picks up where it left off.";
    case "evaluate":
      return "We got the results but couldn't finish the guidance step.";
    default:
      return "We couldn't start this one. Check your connection and try again.";
  }
}

/**
 * @param {number | undefined} ms
 * @returns {string} "" under a second; otherwise e.g. "2m 5s"
 */
function formatWaited(ms) {
  if (typeof ms !== "number" || ms < 1000) return "";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function completedEvidenceCard(
  item,
  sessionCheckId,
  {
    title,
    description,
    editableDescription = description,
    action,
    actionKind = "",
    taskId = "",
    conditionId = "",
    question = null,
    metaLabel = "NEW",
    actionAttribute = "data-analysis-action",
    actionValue = "resolve",
    includeEditDelete = true,
    includeDelete = includeEditDelete,
    isNew = true,
    routeType: route = routeType({ kind: actionKind }),
    createdAt = item.uploadedAt || item.createdAt || "",
    shortId = "",
  },
) {
  const actionClass =
    actionKind === "escalation" ? " analysis-card__primary--escalation" : "";
  const analysisId = item.analysis?.sourceAnalysis?.analysisId || "";
  const artifactId = item.analysis?.artifactId || "";
  const checkId =
    item.checkId || item.analysis?.checkId || sessionCheckId || "";
  return html`
    <article
      class="analysis-card analysis-card--done ${isNew
        ? "analysis-card--new"
        : "analysis-card--standard"}"
      data-item-id="${escapeAttr(item.id || "")}"
      data-check-id="${escapeAttr(checkId)}"
      data-artifact-id="${escapeAttr(artifactId)}"
      data-task-id="${escapeAttr(taskId)}"
      data-analysis-id="${escapeAttr(analysisId)}"
      data-condition-id="${escapeAttr(conditionId)}"
      data-action-kind="${escapeAttr(actionKind)}"
      data-card-title="${escapeAttr(title)}"
      data-card-description="${escapeAttr(description)}"
      data-card-edit-description="${escapeAttr(editableDescription)}"
    >
      <div class="analysis-card__panel">
        <p
          class="analysis-card__route analysis-card__route--${escapeAttr(
            route.tone,
          )}"
        >
          <span aria-hidden="true"></span>${escapeHtml(route.label)}
        </p>
        <div class="analysis-card__layout">
          <div class="analysis-card__content">
            <p class="analysis-card__place">${escapeHtml(cardPlace(item))}</p>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(description)}</p>
            ${question ? clarifyingQuestion(question, conditionId) : ""}
            <div class="analysis-card__actions">
              ${action
                ? html`<button
                    class="analysis-card__primary${actionClass} wa-plain"
                    type="button"
                    ${actionAttribute}="${escapeAttr(actionValue)}"
                  >
                    <wa-icon name="circle-check" aria-hidden="true"></wa-icon>
                    ${escapeHtml(action)}
                  </button>`
                : ""}
              ${includeEditDelete
                ? html`
                    <button
                      class="analysis-card__icon wa-plain"
                      type="button"
                      aria-label="Edit problem"
                      data-analysis-action="edit"
                    >
                      <wa-icon name="pen" aria-hidden="true"></wa-icon>
                    </button>
                  `
                : ""}
              ${includeDelete
                ? html`
                    <button
                      class="analysis-card__icon analysis-card__icon--danger wa-plain"
                      type="button"
                      aria-label="Remove problem"
                      data-analysis-action="delete"
                    >
                      <wa-icon name="trash" aria-hidden="true"></wa-icon>
                    </button>
                  `
                : ""}
            </div>
            <p class="actioncard__error" role="alert" hidden></p>
          </div>
          ${evidencePreview(item)}
        </div>
      </div>
      <footer class="analysis-card__footer">
        <span>${escapeHtml(cardTime(createdAt) || metaLabel)}</span>
        ${shortId ? html`<span>${escapeHtml(shortId)}</span>` : ""}
      </footer>
    </article>
  `;
}

function displayCategory(record) {
  return (
    record?.userFriendlyLabel ||
    record?.user_friendly_label ||
    record?.category ||
    record?.analyzerCategory ||
    record?.canonicalCategory ||
    ""
  );
}

function clarifyingQuestion(question, conditionId) {
  const key = typeof question.key === "string" ? question.key : "";
  const prompt = typeof question.prompt === "string" ? question.prompt : "";
  const options = Array.isArray(question.options) ? question.options : [];
  if (!key || !prompt || !options.length) return "";
  return html`
    <div class="analysis-card__question">
      <p class="analysis-card__question-prompt">${escapeHtml(prompt)}</p>
      <div class="analysis-card__question-actions">
        ${options
          .map(
            (option) => html`
              <button
                class="analysis-card__primary"
                type="button"
                data-analysis-action="answer"
                data-answer-key="${escapeAttr(key)}"
                data-answer-value="${escapeAttr(String(option.value))}"
                data-condition-id="${escapeAttr(conditionId)}"
              >
                ${escapeHtml(option.label || String(option.value))}
              </button>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function evidencePreview(item, placeholder = false) {
  if (placeholder && item.kind !== "text") {
    return html`<div
      class="analysis-card__media analysis-card__media--placeholder"
    >
      <wa-icon name="image" aria-hidden="true"></wa-icon>
    </div>`;
  }
  if (item.kind === "text") {
    return textPreview();
  }
  return imagePreview(item.dataUrl, item.placeName || "Site");
}

function imagePreview(src, placeName) {
  return html`
    <div class="analysis-card__media">
      <img
        src="${escapeAttr(src)}"
        alt="Evidence from ${escapeAttr(placeName || "the site")}"
      />
    </div>
  `;
}

function textPreview() {
  return html`
    <div class="analysis-card__media analysis-card__media--text">
      <wa-icon name="file-lines" aria-hidden="true"></wa-icon>
    </div>
  `;
}

function cardPlace(record) {
  const value =
    record?.georeferencedAddress ||
    record?.address ||
    record?.siteAddress ||
    record?.placeName ||
    "Site";
  return (
    String(value)
      .split(/\r?\n|,/)[0]
      .trim() || "Site"
  );
}

function cardTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${sameDay ? "Today" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)}, ${time}`;
}

function routeType(task) {
  if (task?.kind === "escalation") return { label: "311 request", tone: "311" };
  if (task?.kind === "non_actionable_escalation") {
    const emergency = (task.appActions || []).some(
      (action) =>
        action?.code === "open_phone" &&
        String(action?.payload?.phoneNumber || "").replace(/\D/g, "") === "911",
    );
    return emergency
      ? { label: "Emergency call", tone: "emergency" }
      : { label: "Non-emergency call", tone: "non-emergency" };
  }
  return { label: "On-site action", tone: "onsite" };
}

function taskButtonLabel(task) {
  return Array.isArray(task.buttons) && task.buttons[0]
    ? String(task.buttons[0])
    : "";
}

function actionLabel(kind) {
  if (kind === "non_actionable_escalation") return "Escalate";
  if (kind === "escalation") return "Escalate";
  if (kind === "action") return "Log action";
  return "";
}

function taskArtifactId(task) {
  if (task.evidence?.artifactId) return task.evidence.artifactId;
  if (Array.isArray(task.sourceArtifactIds) && task.sourceArtifactIds[0]) {
    return task.sourceArtifactIds[0];
  }
  const uuidPair =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      String(task.assessmentId || ""),
    );
  return uuidPair?.[1] || "";
}

/**
 * @param {AnalysisItem[]} items
 * @returns {ProblemSummary}
 */
export function problemSummary(items) {
  return items.reduce(
    (summary, item) => {
      if (item.analysis?.status !== "analyzed") return summary;
      const { hiddenConditionIds, visibleTasks, visibleConditions } =
        visibleProblemSelection(item);
      const taskConditionIds = new Set(
        visibleTasks.map((task) => task.conditionId).filter(Boolean),
      );
      const unpairedConditionCount = visibleConditions.filter(
        (condition) => !taskConditionIds.has(condition.conditionId),
      ).length;
      const visible = visibleTasks.length + unpairedConditionCount;
      summary.visible += visible;
      summary.hidden += hiddenConditionIds.size;
      return summary;
    },
    { visible: 0, hidden: 0 },
  );
}

/**
 * @param {ProblemSummary} summary
 * @returns {string}
 */
export function problemSummaryLabel({ visible, hidden }) {
  if (visible > 0) {
    return `${visible} ${visible === 1 ? "problem" : "problems"} found`;
  }
  if (hidden > 0) return "All problems resolved";
  return "No problems found";
}

function hiddenConditionIdSet(item) {
  return new Set(
    [
      ...pendingDeletedConditionIds({
        checkId: item.analysis?.checkId || item.checkId,
        artifactId: item.analysis?.artifactId || item.upload?.artifactId,
      }),
      ...(item.analysis?.resolvedConditionIds || []),
      ...(item.analysis?.rejectedConditionIds || []),
    ].filter(Boolean),
  );
}

/**
 * Select the exact problem units the tray should render for an analyzed item.
 * Prefer visible task cards when tasks remain; otherwise fall back to visible
 * analyzer conditions.
 * @param {AnalysisItem} item
 * @returns {VisibleProblemSelection}
 */
function visibleProblemSelection(item) {
  const hiddenConditionIds = hiddenConditionIdSet(item);
  const visibleTasks = (item.analysis?.tasks || []).filter(
    (task) => !hiddenConditionIds.has(task.conditionId),
  );
  const visibleConditions = (item.analysis?.conditions || []).filter(
    (condition) => !hiddenConditionIds.has(condition.conditionId),
  );
  return { hiddenConditionIds, visibleTasks, visibleConditions };
}
