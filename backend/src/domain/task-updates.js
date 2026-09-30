const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

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
  return /** @type {Record<string, any>} */ (QUALIFYING_ACTIONS)[String(label || "")] || null;
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
  if (photoCount) return photoCount === 1 ? "Updated with photo" : "Updated with photos";
  if (noteCount) return noteCount === 1 ? "Updated with note" : "Updated with notes";
  return "";
}

/** @param {Record<string, any>} task */
export function responseExpectedAt(task) {
  const start = new Date(task?.notifiedAt || task?.inProgressAt || "").getTime();
  const hours = Number(task?.maxAcceptableResponseHours);
  if (!Number.isFinite(start) || !Number.isFinite(hours)) return null;
  return new Date(start + hours * 3_600_000).toISOString();
}
