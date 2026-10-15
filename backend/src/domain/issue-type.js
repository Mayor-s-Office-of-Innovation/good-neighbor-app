/*
  issue-type — the key the reports group issues (tasks) by. Mirrored in the
  frontend (`domain/reports-issues.js` issueTypeKey) so a type in a report
  URL means the same thing the server counted.
*/

/**
 * @param {{ category?: unknown, userFriendlyLabel?: unknown }} task
 * @returns {string}
 */
export function issueTypeKey(task) {
  return (
    String(task?.category || "").trim() ||
    String(task?.userFriendlyLabel || "").trim() ||
    "other"
  );
}
