/*
  Presentational templates for <perimeter-check>.

  The new perimeter flow renders every place in a vertical timeline while each
  photo or typed description analyzes independently.
*/
import { html, escapeHtml, escapeAttr } from "../lib/html.js";

export const shell = () => html`
  <div class="flow view-check check check-timeline">
    <div class="check-timeline__topbar">
      <span aria-hidden="true"></span>
      <button class="check-timeline__close" id="cancel" type="button">
        <span class="check-timeline__close-icon" aria-hidden="true"></span>
        <span class="visually-hidden">Close check</span>
      </button>
    </div>

    <h1 class="check-timeline__title">
      Take photos at each place.
    </h1>

    <div class="place-timeline" id="place-timeline"></div>

    <div class="check-timeline__footer" id="check-footer"></div>

    <dialog class="places-modal add-place-dialog" id="add-place-dialog">
      <form class="places-modal__card add-place-dialog__panel" method="dialog">
        <div class="places-modal__copy">
          <h2 class="places-modal__title">Add a place</h2>
          <p class="places-modal__text">
            Add a place that isn't already in the list. It will be added to this
            check only.
          </p>
        </div>
        <label class="add-place-dialog__field">
          <span>Place name</span>
          <input
            id="add-place-name"
            type="text"
            autocomplete="off"
            placeholder="Example: Main entrance"
          />
          <small id="add-place-error" role="alert"></small>
        </label>
        <div class="places-modal__actions add-place-dialog__actions">
          <button
            class="btn-ink places-modal__primary"
            id="add-place-submit"
            type="button"
            disabled
          >
            Add place
          </button>
          <button
            class="places-modal__danger add-place-dialog__cancel"
            type="submit"
            value="cancel"
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      class="places-modal done-incomplete-dialog"
      id="done-incomplete-dialog"
      aria-labelledby="done-incomplete-title"
      aria-describedby="done-incomplete-copy"
    >
      <form
        class="places-modal__card done-incomplete-dialog__panel"
        method="dialog"
      >
        <div class="places-modal__copy">
          <h2 class="places-modal__title" id="done-incomplete-title">
            Finish now?
          </h2>
          <p class="places-modal__text" id="done-incomplete-copy"></p>
        </div>
        <div class="places-modal__actions done-incomplete-dialog__actions">
          <button
            class="btn-ink places-modal__primary"
            id="done-incomplete-keep"
            type="submit"
          >
            Keep checking
          </button>
          <button
            class="places-modal__danger"
            id="done-incomplete-finish"
            type="button"
          >
            Finish anyway
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      class="analysis-dialog"
      id="analysis-delete-dialog"
      aria-labelledby="analysis-delete-title"
      aria-describedby="analysis-delete-copy"
    >
      <form class="analysis-dialog__card" method="dialog">
        <div class="analysis-dialog__copy">
          <h2 class="analysis-dialog__title" id="analysis-delete-title"></h2>
          <p class="analysis-dialog__text" id="analysis-delete-copy">
            This action can't be undone. The issue details won't be saved.
          </p>
          <p class="analysis-dialog__error" id="analysis-delete-error" hidden></p>
        </div>
        <div class="analysis-dialog__actions">
          <button
            class="analysis-dialog__button analysis-dialog__button--danger"
            id="analysis-delete-confirm"
            type="button"
          >
            Delete
          </button>
          <button class="analysis-dialog__button" type="submit">
            Cancel
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      class="analysis-dialog"
      id="analysis-success-dialog"
      aria-labelledby="analysis-success-title"
      aria-describedby="analysis-success-copy"
    >
      <form class="analysis-dialog__card" method="dialog">
        <div class="analysis-dialog__copy">
          <h2 class="analysis-dialog__title" id="analysis-success-title">
            Great work!
          </h2>
          <p class="analysis-dialog__text" id="analysis-success-copy">
            We've recorded your action. This item is now
            <span>marked as resolved.</span>
          </p>
        </div>
        <div class="analysis-dialog__actions">
          <button
            class="analysis-dialog__button analysis-dialog__button--success"
            type="submit"
          >
            Continue
          </button>
          <button
            class="analysis-dialog__button"
            id="analysis-success-undo"
            type="button"
          >
            Undo
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      class="analysis-dialog"
      id="analysis-progress-dialog"
      aria-labelledby="analysis-progress-title"
    >
      <div class="analysis-dialog__card analysis-dialog__card--progress">
        <h2 class="analysis-dialog__title" id="analysis-progress-title">
          Filing ticket...
        </h2>
        <div class="analysis-progress-ring" aria-hidden="true"></div>
        <button
          class="analysis-dialog__button"
          id="analysis-progress-cancel"
          type="button"
        >
          Cancel
        </button>
      </div>
    </dialog>

    <dialog
      class="analysis-dialog analysis-edit-dialog"
      id="analysis-edit-dialog"
      aria-labelledby="analysis-edit-title"
      aria-describedby="analysis-edit-copy"
    >
      <form class="analysis-dialog__card" method="dialog">
        <div class="analysis-dialog__copy">
          <h2 class="analysis-dialog__title" id="analysis-edit-title">
            Edit problem
          </h2>
          <p class="analysis-dialog__text" id="analysis-edit-copy">
            Change the description to match what you see
          </p>
          <p class="analysis-dialog__error" id="analysis-edit-error" hidden></p>
        </div>
        <label class="analysis-edit-dialog__field">
          <span>Description</span>
          <textarea id="analysis-edit-description" rows="5"></textarea>
        </label>
        <div class="analysis-dialog__actions">
          <button
            class="analysis-dialog__button analysis-dialog__button--ink"
            id="analysis-edit-save"
            type="button"
          >
            Save
          </button>
          <button
            class="analysis-dialog__button analysis-dialog__button--danger-text"
            type="submit"
          >
            Discard
          </button>
        </div>
      </form>
    </dialog>

    <dialog
      class="sheet"
      id="cancel-check-dialog"
      aria-label="Leave this check?"
    >
      <div class="sheet__panel">
        <div class="sheet__actions">
          <button
            class="sheet__cancel"
            type="button"
            id="cancel-check-save"
          >
            Save my place to resume later
          </button>
        </div>
        <ul class="sheet__opts">
          <li>
            <button
              class="sheet__opt sheet__opt--danger"
              id="cancel-check-discard"
              type="button"
            >
              End the check and exit
            </button>
          </li>
        </ul>
      </div>
    </dialog>

    <input
      type="file"
      id="file-input"
      class="visually-hidden"
      tabindex="-1"
      aria-hidden="true"
      accept="image/*"
      capture="environment"
    />
  </div>
`;

function placeSummary(place) {
  const photoCount = place.items.filter((item) => item.kind === "photo").length;
  const textCount = place.items.filter((item) => item.kind === "text").length;
  const analyzing = place.items.some((item) =>
    ["queued", "analyzing"].includes(item.analysis?.status),
  );
  if (place.skipped) return "Skipped for now";
  const pieces = [];
  if (photoCount) {
    pieces.push(`${photoCount} ${photoCount === 1 ? "photo" : "photos"}`);
  }
  if (textCount) {
    pieces.push(`${textCount} typed note${textCount === 1 ? "" : "s"}`);
  }
  if (analyzing) pieces.push("Analyzing...");
  return pieces.join(" · ");
}

export function placeRow({
  place,
  index,
  expanded,
  isLast,
  openMenuItemId,
  photoMenuAnchor,
}) {
  const summary = placeSummary(place);
  const complete = place.items.length > 0 || place.skipped;
  return html`
    <section class="place-row ${expanded ? "place-row--expanded" : ""}">
      <div class="place-row__rail" aria-hidden="true">
        <span
          class="place-row__step ${complete ? "place-row__step--done" : ""}"
        >
          ${complete
            ? html`<span class="place-row__check" aria-hidden="true"></span>`
            : index + 1}
        </span>
        <span
          class="place-row__line ${complete
            ? "place-row__line--done"
            : ""} ${isLast ? "place-row__line--short" : ""}"
        ></span>
      </div>
      <div class="place-row__body">
        <button
          class="place-row__header"
          type="button"
          data-toggle-place="${escapeAttr(place.id)}"
          aria-expanded="${expanded ? "true" : "false"}"
        >
          <span>${escapeHtml(place.name)}</span>
          <span
            class="place-row__caret ${expanded ? "place-row__caret--up" : ""}"
            aria-hidden="true"
          ></span>
        </button>
        ${summary
          ? html`<p class="place-row__summary">${escapeHtml(summary)}</p>`
          : ""}
        ${conditionList(place.conditionLabels || [])}
        ${expanded ? expandedPlace(place, openMenuItemId, photoMenuAnchor) : ""}
      </div>
    </section>
  `;
}

function expandedPlace(place, openMenuItemId, photoMenuAnchor) {
  return html`
    <div class="place-row__expanded">
      ${place.inputMode === "text"
        ? textMode(place)
        : photoMode(place, openMenuItemId, photoMenuAnchor)}
    </div>
  `;
}

function photoMode(place, openMenuItemId, photoMenuAnchor) {
  const photos = place.items.filter((item) => item.kind === "photo");
  const openMenuItem = photos.find((item) => item.id === openMenuItemId);
  return html`
    ${photos.length === 0
      ? html`<p class="place-row__prompt">
          Start with a photo of the whole area.
        </p>`
      : ""}
    <div
      class="perimeter-photos"
      aria-label="Photos for ${escapeAttr(place.name)}"
    >
      ${addPhotoTile(
        photos.length === 0 ? "Take photo" : "Add detail photo",
        place.id,
      )}
      ${photos
        .map((item, index) =>
          photoTile(item, index, openMenuItemId === item.id),
        )
        .join("")}
    </div>
    ${openMenuItem ? photoMenu(openMenuItem, photoMenuAnchor) : ""}
    ${inlineAnalyzing(place)}
    <div class="place-row__actions">
      <button
        class="btn-pill btn-pill--filled"
        type="button"
        data-next-place="${escapeAttr(place.id)}"
      >
        ${place.items.length ? "Next place" : "Skip for now"}
      </button>
      <button
        class="btn-pill btn-pill--outline"
        type="button"
        data-type-place="${escapeAttr(place.id)}"
      >
        Type instead
      </button>
    </div>
  `;
}

function textMode(place) {
  return html`
    <p class="place-row__prompt">
      Describe the whole area, even if there are no problems.
    </p>
    <label class="typed-evidence">
      <span class="visually-hidden"
        >Description for ${escapeHtml(place.name)}</span
      >
      <textarea
        data-text-input="${escapeAttr(place.id)}"
        rows="5"
        placeholder="At ${escapeAttr(place.name)}, ..."
      >
${escapeHtml(place.draftText || "")}</textarea
      >
    </label>
    <div class="place-row__actions">
      <button
        class="btn-pill btn-pill--outline"
        type="button"
        data-photo-place="${escapeAttr(place.id)}"
      >
        Take a photo instead
      </button>
    </div>
  `;
}

function addPhotoTile(label, placeId) {
  return html`
    <button
      class="perimeter-photo perimeter-photo--add"
      type="button"
      data-add-photo="${escapeAttr(placeId)}"
    >
      <span class="perimeter-photo__camera" aria-hidden="true">
        <wa-icon name="camera"></wa-icon>
      </span>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function photoTile(item, index, menuOpen) {
  return html`
    <div class="perimeter-photo perimeter-photo--captured">
      <img
        src="${escapeAttr(item.dataUrl)}"
        alt="Captured photo ${index + 1} for ${escapeAttr(
          item.placeName || "this place",
        )}"
      />
      <button
        class="perimeter-photo__menu-button wa-plain"
        type="button"
        data-photo-menu="${escapeAttr(item.id)}"
        aria-label="Photo options"
        aria-expanded="${menuOpen ? "true" : "false"}"
      >
        <wa-icon name="ellipsis" aria-hidden="true"></wa-icon>
      </button>
    </div>
  `;
}

function photoMenu(item, anchor) {
  const style = anchor
    ? `--photo-menu-top:${anchor.top}px;--photo-menu-right:${anchor.right}px;`
    : "";
  return html`
    <div
      class="photo-menu"
      role="menu"
      aria-label="Photo options"
      style="${escapeAttr(style)}"
    >
      <button
        type="button"
        role="menuitem"
        data-photo-action="note"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="pen-clip" aria-hidden="true"></wa-icon>
        Add note
      </button>
      <button
        type="button"
        role="menuitem"
        data-photo-action="replace"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="repeat" aria-hidden="true"></wa-icon>
        Replace photo
      </button>
      <button
        type="button"
        role="menuitem"
        data-photo-action="move"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="arrow-down" aria-hidden="true"></wa-icon>
        Move to another place
      </button>
      <button
        class="photo-menu__danger"
        type="button"
        role="menuitem"
        data-photo-action="remove"
        data-item-id="${escapeAttr(item.id)}"
      >
        <wa-icon name="trash" aria-hidden="true"></wa-icon>
        Remove photo
      </button>
    </div>
  `;
}

function inlineAnalyzing(place) {
  if (
    !place.items.some((item) =>
      ["queued", "analyzing"].includes(item.analysis?.status),
    )
  ) {
    return "";
  }
  return html`
    <div class="place-row__inline-ai" aria-live="polite">
      <wa-icon name="sparkles" aria-hidden="true"></wa-icon>
      <span></span>
    </div>
  `;
}

function conditionList(labels) {
  if (!labels.length) return "";
  return html`
    <ul class="place-row__conditions">
      ${labels
        .map(
          (label) => html`
            <li>
              <wa-icon name="sparkles" aria-hidden="true"></wa-icon>
              <span>${escapeHtml(label)}</span>
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

export function addPlaceButton() {
  return html`
    <button class="place-timeline__add" id="add-place-open" type="button">
      <span class="place-timeline__add-icon" aria-hidden="true"></span>
      <span class="visually-hidden">Add a place</span>
    </button>
  `;
}

export function footer({ items, analyzingOpen }) {
  const active = items.some((item) =>
    ["queued", "analyzing"].includes(item.analysis?.status),
  );
  const problems = problemSummary(items);
  const problemLabel = active ? "Analyzing..." : problemSummaryLabel(problems);
  return html`
    <button class="check-timeline__done" id="done-check" type="button">
      Done
    </button>
    ${items.length
      ? html`
          <button
            class="check-timeline__analyzing"
            id="toggle-analyzing"
            type="button"
            aria-expanded="${analyzingOpen ? "true" : "false"}"
          >
            ${problemLabel}
            <span
              class="check-timeline__analyzing-caret ${analyzingOpen
                ? "check-timeline__analyzing-caret--up"
                : ""}"
              aria-hidden="true"
            ></span>
          </button>
        `
      : ""}
  `;
}

export function analyzingSection(items) {
  if (!items.length) return "";
  const cards = items.map(analysisCards).flat();
  const summary = problemSummary(items);
  return html`
    <section
      class="analysis-tray"
      id="analysis-tray"
      aria-label="Analyzing evidence"
    >
      <h2>Analysis results</h2>
      ${cards.length
        ? html`<div class="analysis-tray__cards">${cards.join("")}</div>`
        : summary.hidden > 0
          ? html`<p class="analysis-tray__empty">
              All problems were resolved or deleted.
            </p>`
          : ""}
    </section>
  `;
}

function analysisCards(item) {
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
      completedCard(item, {
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
      return completedCard(item, {
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
    completedCard(item, {
      title: condition.category || "Condition found",
      description: condition.description || "Review this condition.",
      action: "",
      actionKind: "",
      conditionId: condition.conditionId || "",
    }),
  );
}

function pendingCard(item) {
  return html`
    <article class="analysis-card analysis-card--pending">
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

function completedCard(
  item,
  { title, description, action, actionKind = "", taskId = "", conditionId = "" },
) {
  const actionClass =
    actionKind === "escalation" ? " analysis-card__primary--escalation" : "";
  const analysisId = item.analysis?.sourceAnalysis?.analysisId || "";
  return html`
    <article
      class="analysis-card analysis-card--done"
      data-place-id="${escapeAttr(item.placeId || "")}"
      data-item-id="${escapeAttr(item.id || "")}"
      data-task-id="${escapeAttr(taskId)}"
      data-analysis-id="${escapeAttr(analysisId)}"
      data-condition-id="${escapeAttr(conditionId)}"
      data-action-kind="${escapeAttr(actionKind)}"
      data-card-title="${escapeAttr(title)}"
      data-card-description="${escapeAttr(description)}"
    >
      <div class="analysis-card__content">
        <p class="analysis-card__meta">
          <img
            class="analysis-card__star"
            src="/icons/star.svg"
            alt=""
            aria-hidden="true"
          />
          <span>NEW</span>${item.analysis?.assessment?.assessmentId
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
                data-analysis-action="resolve"
              >
                <wa-icon name="circle-check" aria-hidden="true"></wa-icon>
                ${escapeHtml(action)}
              </button>`
            : ""}
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
        </div>
      </div>
      ${evidencePreview(item)}
    </article>
  `;
}

function evidencePreview(item) {
  if (item.kind === "text") {
    return html`
      <div class="analysis-card__media analysis-card__media--text">
        <span>${escapeHtml(item.placeName || "Place")}</span>
        <wa-icon name="file-lines" aria-hidden="true"></wa-icon>
      </div>
    `;
  }
  return html`
    <div class="analysis-card__media">
      <img
        src="${escapeAttr(item.dataUrl)}"
        alt="Evidence from ${escapeAttr(item.placeName || "this place")}"
      />
      <span>${escapeHtml(item.placeName || "Place")}</span>
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

function problemSummary(items) {
  return items.reduce((summary, item) => {
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
    const visible = Math.max(visibleTasks.length, visibleConditions.length);
    const total = Math.max(tasks.length, conditions.length);
    summary.visible += visible;
    summary.hidden += Math.max(
      hiddenConditionIds.size,
      Math.max(0, total - visible),
    );
    return summary;
  }, { visible: 0, hidden: 0 });
}

function problemSummaryLabel({ visible, hidden }) {
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

// Compatibility exports for <problem-report>, which still uses the older grid.
export const shotTile = (item, index) => html`
  <div class="shot">
    <img
      class="shot__img"
      src="${escapeAttr(item.dataUrl)}"
      alt="Captured photo ${index + 1}${item.placeName
        ? ` for ${escapeAttr(item.placeName)}`
        : ""}"
    />
    <button
      class="shot__del"
      type="button"
      data-del="${escapeAttr(item.id)}"
      aria-label="Delete photo"
    >
      <wa-icon name="trash" aria-hidden="true"></wa-icon>
    </button>
  </div>
`;

export const addTile = (empty) => html`
  <button
    class="addshot ${empty ? "addshot--empty" : ""}"
    id="add-photo"
    type="button"
  >
    <span class="addshot__label">Add photo</span>
    ${empty
      ? html`<span class="addshot__hint">Tap to open your camera</span>`
      : ""}
  </button>
`;
