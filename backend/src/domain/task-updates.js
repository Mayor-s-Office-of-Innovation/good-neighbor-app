const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const MAX_PHOTOS = 6;
const MAX_NOTES = 3;
const MAX_TEXT = 4000;

export const QUALIFYING_ACTIONS = Object.freeze({
  "We called SFPD non-emergency": {
    actionKind: "sfpd_non_emergency",
    agency: "SFPD",
    label: "Called non-emergency line",
  },
  "We called 911": {
    actionKind: "called_911",
    agency: "SFPD",
    label: "Called 911",
  },
  "We called SFACC": {
    actionKind: "called_sfacc",
    agency: "SFACC",
    label: "Called SFACC",
  },
  "We called 311": {
    actionKind: "called_311",
    agency: "311",
    label: "Called 311",
  },
});

/** @param {unknown} label */
export function qualifyingAction(label) {
  return (
    /** @type {Record<string, any>} */ (QUALIFYING_ACTIONS)[
      String(label || "")
    ] || null
  );
}

/** @param {string | number | Date} inProgressAt @param {string | number | Date} [now] */
export function presencePeriod(inProgressAt, now = new Date()) {
  const start = new Date(inProgressAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current) || current < start)
    return 0;
  return Math.floor((current - start) / FOUR_HOURS_MS);
}

/** @param {Record<string, any>} task @param {string | number | Date} [now] */
export function presencePromptDue(task, now = new Date()) {
  if (task?.status !== "in_progress" || !task?.inProgressAt) return false;
  const period = presencePeriod(task.inProgressAt, now);
  return period >= 1 && Number(task.lastAnsweredPresencePeriod || 0) < period;
}

/** @param {unknown[]} notes @param {unknown[]} photos */
export function notePhotoLabel(notes, photos) {
  const noteCount = Array.isArray(notes) ? notes.length : 0;
  const photoCount = Array.isArray(photos) ? photos.length : 0;
  if (noteCount && photoCount) return "Updated with photos and notes";
  if (photoCount)
    return photoCount === 1 ? "Updated with photo" : "Updated with photos";
  if (noteCount)
    return noteCount === 1 ? "Updated with note" : "Updated with notes";
  return "";
}

/** @param {Record<string, any>} task */
export function responseExpectedAt(task) {
  const start = new Date(
    task?.notifiedAt || task?.inProgressAt || "",
  ).getTime();
  const hours = Number(task?.maxAcceptableResponseHours);
  if (!Number.isFinite(start) || !Number.isFinite(hours) || hours <= 0)
    return null;
  return new Date(start + hours * 3_600_000).toISOString();
}

/** @param {unknown} value @param {number} max @returns {string[] | null} */
function textList(value, max) {
  if (!Array.isArray(value) || value.length > max) return null;
  const values = value.map((item) => String(item || "").trim());
  return values.every((item) => item && item.length <= MAX_TEXT)
    ? values
    : null;
}

/** @param {unknown} value @returns {string[] | null} */
function photoList(value) {
  if (!Array.isArray(value) || value.length > MAX_PHOTOS) return null;
  const values = value.map((item) => String(item || "").trim());
  return values.every((item) => item && item.length <= 512) ? values : null;
}

/**
 * Build the immutable event and replacement task snapshot for an in-progress update.
 * @param {Record<string, any>} task
 * @param {Record<string, any>} input
 * @param {{ taskId: string, updateId: string, actorId: string, now?: Date }} context
 * @returns {{ error: string, statusCode: number } | { update: Record<string, any>, task: Record<string, any> }}
 */
export function buildTaskUpdateTransition(task, input, context) {
  const type = String(input.type || "");
  const nowDate = context.now || new Date();
  const now = nowDate.toISOString();
  let label = "";
  let timelineLabel = "";
  let documentationState = "closed";
  let resolved = false;
  let period;
  /** @type {string[]} */
  let notes = [];
  /** @type {string[]} */
  let photoKeys = [];
  let text;

  if (type === "presence_still_present" || type === "presence_resolved") {
    period = presencePeriod(task.inProgressAt, nowDate);
    if (period < 1 || Number(task.lastAnsweredPresencePeriod || 0) >= period)
      return { error: "Presence prompt is not due", statusCode: 409 };
    resolved = type === "presence_resolved";
    label = resolved ? "Resolved" : "Still present";
    timelineLabel = resolved ? "Site team marked as resolved" : "Still there";
    documentationState = "open_for_documentation";
  } else if (type === "note_photo_update") {
    const parsedNotes = textList(input.notes, MAX_NOTES);
    const parsedPhotos = photoList(input.photoKeys);
    if (!parsedNotes || !parsedPhotos)
      return { error: "Invalid notes or photos", statusCode: 400 };
    label = notePhotoLabel(parsedNotes, parsedPhotos);
    if (!label)
      return { error: "An update needs a note or photo", statusCode: 400 };
    timelineLabel = label;
    notes = parsedNotes;
    photoKeys = parsedPhotos;
  } else if (
    type === "additional_action_resolved" ||
    type === "additional_action_still_present"
  ) {
    text = String(input.text || "").trim();
    if (!text || text.length > MAX_TEXT)
      return { error: "Invalid action", statusCode: 400 };
    resolved = type === "additional_action_resolved";
    label = resolved ? "Resolved" : "Still present";
    timelineLabel = "Additional action taken";
    documentationState = "open_for_documentation";
  } else if (type === "additional_action") {
    text = String(input.text || "").trim();
    const parsedPhotos = photoList(input.photoKeys);
    if (!text || text.length > MAX_TEXT || !parsedPhotos)
      return { error: "Invalid action or photos", statusCode: 400 };
    label = "More action taken";
    timelineLabel = "Additional action taken";
    photoKeys = parsedPhotos;
  } else return { error: "Unsupported update type", statusCode: 400 };

  const update = {
    entityType: "task_update",
    taskId: context.taskId,
    updateId: context.updateId,
    type,
    label: timelineLabel,
    occurredAt: now,
    actorId: context.actorId,
    documentationState,
    ...(period ? { presencePeriod: period } : {}),
    ...(text ? { text } : {}),
    ...(notes.length ? { notes } : {}),
    ...(photoKeys.length ? { photoKeys } : {}),
  };
  const status = resolved ? "completed" : "in_progress";
  return {
    update,
    task: {
      ...task,
      status,
      latestUpdateId: context.updateId,
      latestUpdateLabel: label,
      updatedAt: now,
      ...(period ? { lastAnsweredPresencePeriod: period } : {}),
      ...(resolved
        ? {
            resolvedAt: now,
            completedAt: now,
            completionMethod: "site_team_resolved",
          }
        : {}),
    },
  };
}
