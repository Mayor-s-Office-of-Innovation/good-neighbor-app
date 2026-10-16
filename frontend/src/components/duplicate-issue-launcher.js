// Keep the optional detail/separation UI out of the initial application bundle.
// Ordinary cards, live matching and phone handoff remain immediately available.
/** @param {Parameters<typeof import("./duplicate-issue-dialog.js").openDuplicateIssue>} args */
export async function openDuplicateIssue(...args) {
  const details = await import("./duplicate-issue-dialog.js");
  if (args[1].isConnected) details.openDuplicateIssue(...args);
}
/** @param {Parameters<typeof import("./duplicate-issue-dialog.js").openSessionDuplicate>} args */
export async function openSessionDuplicate(...args) {
  const details = await import("./duplicate-issue-dialog.js");
  if (args[0].isConnected && args[1].isConnected)
    details.openSessionDuplicate(...args);
}
