import { html, escapeHtml, escapeAttr } from "../lib/html.js";

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
  } = {},
) {
  const cards = items.map((item) => analysisCards(item, sessionCheckId)).flat();
  const summary = problemSummary(items);
  return html`
    <section
      class="analysis-tray analysis-tray--${escapeAttr(tone)}"
      id="${escapeAttr(id)}"
      aria-label="${escapeAttr(ariaLabel)}"
    >
      ${title ? html`<h2>${escapeHtml(title)}</h2>` : ""}
      ${cards.length
        ? html`<div class="analysis-tray__cards">
            ${cards.join("")}${footer}
          </div>`
        : summary.hidden > 0
          ? html`<p class="analysis-tray__empty">${escapeHtml(emptyText)}</p>`
          : ""}
    </section>
  `;
}

export function analysisCards(item, sessionCheckId) {
  const status = item.analysis?.status || "idle";
  if (status !== "analyzed") return [pendingCard(item)];
  const hiddenConditionIds = hiddenConditionIdSet(item);
  const tasks = (item.analysis?.tasks || []).filter(
    (task) => !hiddenConditionIds.has(task.conditionId),
  );
  const conditions = (item.analysis?.conditions || []).filter(
    (condition) => !hiddenConditionIds.has(condition.conditionId),
  );
  if (!tasks.length && !conditions.length) {
    if (hiddenConditionIds.size || item.analysis?.hideNoIssuesCard) return [];
    return [
      completedEvidenceCard(item, sessionCheckId, {
        title: "No issues found",
        description:
          item.analysis?.noIssuesDescription ||
          "The analysis did not identify any conditions of concern.",
        action: "",
        actionKind: "",
      }),
    ];
  }
  if (tasks.length) {
    return tasks.map((task, index) => {
      const condition =
        conditions.find(
          (candidate) =>
            task.conditionId && candidate.conditionId === task.conditionId,
        ) ||
        conditions[index] ||
        {};
      return completedEvidenceCard(item, sessionCheckId, {
        title: task.category || condition.category || "Condition found",
        description:
          task.guidance || condition.description || "Review this condition.",
        action: taskButtonLabel(task) || actionLabel(task.kind),
        actionKind: task.kind || "",
        taskId: task.taskId || "",
        conditionId: task.conditionId || condition.conditionId || "",
      });
    });
  }
  return conditions.map((condition) =>
    completedEvidenceCard(item, sessionCheckId, {
      title: condition.category || "Condition found",
      description: condition.description || "Review this condition.",
      action: "",
      actionKind: "",
      conditionId: condition.conditionId || "",
    }),
  );
}

export function taskAnalysisCard({ task, action, statusLabel, isNew = false }) {
  const mediaUrl =
    task.thumbnailUrl ||
    task.thumbUrl ||
    task.mediaUrl ||
    task.photoUrl ||
    task.imageUrl ||
    "";
  const placeName =
    task.evidence?.placeName ||
    task.placeName ||
    task.positionDescriptor ||
    task.position_descriptor ||
    task.location ||
    "";
  const evidenceText = task.evidence?.text || task.text || "";
  const pseudoItem = {
    id: task.taskId || "",
    kind: mediaUrl ? "photo" : "text",
    dataUrl: mediaUrl,
    text: evidenceText,
    placeId: task.placeId || task.positionDescriptor || "",
    placeName: placeName || "Site",
    checkId: task.checkId || "",
    analysis: {
      artifactId: taskArtifactId(task),
      assessment: {},
      sourceAnalysis: {},
    },
  };
  return completedEvidenceCard(pseudoItem, task.checkId || "", {
    title:
      task.category || task.analyzerCategory || task.label || "Condition found",
    description: task.guidance || task.description || task.category || "",
    action: action?.label || "Done",
    actionKind: action?.variant === "blue" ? "escalation" : "action",
    taskId: task.taskId || "",
    conditionId: task.conditionId || "",
    metaLabel: statusLabel || (isNew ? "NEW" : "NEEDS ACTION"),
    actionAttribute: "data-action",
    actionValue: action?.kind || "done",
    includeEditDelete: true,
    isNew,
    showStar: isNew,
  });
}

function pendingCard(item) {
  return html`
    <article class="analysis-card analysis-card--pending analysis-card--new">
      <div class="analysis-card__content">
        <p class="analysis-card__meta">
          <img
            class="analysis-card__star"
            src="/icons/star.svg"
            alt=""
            aria-hidden="true"
          />
          IN PROGRESS
        </p>
        <h3>Analyzing ${item.kind === "text" ? "description" : "photo"}...</h3>
        <span class="skeleton-line skeleton-line--wide"></span>
        <span class="skeleton-line skeleton-line--mid"></span>
      </div>
      ${evidencePreview(item)}
    </article>
  `;
}

function completedEvidenceCard(
  item,
  sessionCheckId,
  {
    title,
    description,
    action,
    actionKind = "",
    taskId = "",
    conditionId = "",
    metaLabel = "NEW",
    actionAttribute = "data-analysis-action",
    actionValue = "resolve",
    includeEditDelete = true,
    isNew = true,
    showStar = true,
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
      data-place-id="${escapeAttr(item.placeId || "")}"
      data-item-id="${escapeAttr(item.id || "")}"
      data-check-id="${escapeAttr(checkId)}"
      data-artifact-id="${escapeAttr(artifactId)}"
      data-task-id="${escapeAttr(taskId)}"
      data-analysis-id="${escapeAttr(analysisId)}"
      data-condition-id="${escapeAttr(conditionId)}"
      data-action-kind="${escapeAttr(actionKind)}"
      data-card-title="${escapeAttr(title)}"
      data-card-description="${escapeAttr(description)}"
    >
      <div class="analysis-card__content">
        <p class="analysis-card__meta">
          ${showStar
            ? html`<img
                class="analysis-card__star"
                src="/icons/star.svg"
                alt=""
                aria-hidden="true"
              />`
            : ""}
          <span>${escapeHtml(metaLabel)}</span>${item.analysis?.assessment
            ?.assessmentId
            ? html`<span>•</span
                ><span
                  >${escapeHtml(item.analysis.assessment.assessmentId)}</span
                >`
            : ""}
        </p>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(description)}</p>
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
    </article>
  `;
}

function evidencePreview(item) {
  if (item.kind === "text") {
    return textPreview(item.placeName || "Place");
  }
  return imagePreview(item.dataUrl, item.placeName || "Place");
}

function imagePreview(src, placeName) {
  return html`
    <div class="analysis-card__media">
      <img
        src="${escapeAttr(src)}"
        alt="Evidence from ${escapeAttr(placeName || "this place")}"
      />
      <span>${escapeHtml(placeName || "Place")}</span>
    </div>
  `;
}

function textPreview(placeName) {
  return html`
    <div class="analysis-card__media analysis-card__media--text">
      <span>${escapeHtml(placeName || "Place")}</span>
      <wa-icon name="file-lines" aria-hidden="true"></wa-icon>
    </div>
  `;
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

export function problemSummary(items) {
  return items.reduce(
    (summary, item) => {
      if (item.analysis?.status !== "analyzed") return summary;
      const hiddenConditionIds = hiddenConditionIdSet(item);
      const tasks = item.analysis?.tasks || [];
      const conditions = item.analysis?.conditions || [];
      const visibleTasks = tasks.filter(
        (task) => !hiddenConditionIds.has(task.conditionId),
      );
      const visibleConditions = conditions.filter(
        (condition) => !hiddenConditionIds.has(condition.conditionId),
      );
      const visible = tasks.length
        ? visibleTasks.length
        : visibleConditions.length;
      summary.visible += visible;
      summary.hidden += hiddenConditionIds.size;
      return summary;
    },
    { visible: 0, hidden: 0 },
  );
}

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
      ...(item.analysis?.resolvedConditionIds || []),
      ...(item.analysis?.rejectedConditionIds || []),
    ].filter(Boolean),
  );
}
