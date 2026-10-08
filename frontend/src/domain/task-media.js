/**
 * Return the best already-hydrated media URL for a task.
 * @param {Record<string, any>} task
 * @returns {string}
 */
export function taskMediaUrl(task) {
  return (
    task.thumbnailUrl ||
    task.thumbUrl ||
    task.mediaUrl ||
    task.photoUrl ||
    task.imageUrl ||
    ""
  );
}
