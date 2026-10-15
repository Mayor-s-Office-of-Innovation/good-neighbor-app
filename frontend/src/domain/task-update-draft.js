export const MAX_TASK_UPDATE_PHOTOS = 6;
export const MAX_TASK_UPDATE_NOTES = 3;
export const MAX_TASK_UPDATE_TEXT = 4000;

/** @returns {string[]} */
export function emptyTaskUpdateNotes() {
  return Array(MAX_TASK_UPDATE_NOTES).fill("");
}

/**
 * @param {string} mode
 * @param {{ files: unknown[], notes: string[], actionText: string }} draft
 */
export function hasUnsavedTaskUpdateDraft(mode, draft) {
  const hasPhotos = draft.files.length > 0;
  const hasNotes = draft.notes.some((note) => note.trim());
  if (["notes", "note-text"].includes(mode)) return hasPhotos || hasNotes;
  if (mode === "action") return Boolean(draft.actionText.trim());
  if (mode === "action-photos") return hasPhotos;
  return false;
}
