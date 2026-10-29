import {
  isTaskExpired,
  needsResolutionProof,
  submitted311Ticket,
  taskResolution,
} from "./home-tasks.js";
import { filing311State } from "./task-actions.js";
import { duplicateUiEnabled } from "../services/feature-flags.js";

/** A single ordered decision table for every issue-card surface.
 * @param {Record<string, any>} task
 * @param {{history?:boolean, now?:number}} options
 */
export function statusTicker(task, { history = false, now = Date.now() } = {}) {
  const state = (key, tone, icon = "circle-exclamation", count = 0) => ({
    key,
    tone,
    icon,
    count,
  });
  if (history || task.status === "completed" || isTaskExpired(task, now)) {
    if (needsResolutionProof(task))
      return state("awaitingProof", "warning", "file-circle-check");
    if (task.proofAddedAt) return state("resolved", "success", "circle-check");
    const { confirmed } = taskResolution(task);
    if (confirmed) return state("resolved", "success", "circle-check");
    return state("", "muted", "dot");
  }
  const created = Date.parse(task.createdAt || task.created_at || "");
  if (Number.isFinite(created) && now - created > 7 * 86400000)
    return state("old", "warning");
  const inProgress = ["in_progress", "completing", "resolving"].includes(
    task.status,
  );
  if (!inProgress) {
    if (duplicateUiEnabled()) {
      if (task.duplicate) return state("duplicate", "muted", "clone");
      if (task.duplicateCheckState === "pending")
        return state("checking", "muted", "spinner");
      if (task.duplicateSeenCount > 1)
        return state(
          "seen",
          "warning",
          "circle-exclamation",
          task.duplicateSeenCount,
        );
    }
    const numbers = [
      task.phoneNumber,
      ...(task.appActions || [])
        .filter((a) => a.code === "open_phone")
        .map((a) => a.payload?.phoneNumber),
    ].map((n) => String(n || "").replace(/\D/g, ""));
    const urgent = numbers.some((n) =>
      ["911", "4155530123", "14155530123"].includes(n),
    );
    return state(
      "needsAction",
      urgent ? "danger" : "action",
      urgent ? "circle-exclamation" : "dot",
    );
  }
  const filing = filing311State(task);
  if (filing === "queued") return state("filing", "progress", "spinner");
  if (filing === "failed") return state("filingFailed", "warning");
  const filed = Boolean(submitted311Ticket(task));
  if (filed && task.ticketStatus === "Closed")
    return state("cityClosed", "warning");
  if (filed && task.ticketResponseOverdue) return state("overdue", "warning");
  if (filed && task.ticketStatus === "Scheduled")
    return state("scheduled", "progress", "calendar-check");
  if (filed && task.ticketStatus === "On hold")
    return state("onHold", "progress", "circle-pause");
  if (filed) return state("filed", "progress", "paper-plane");
  if (
    task.kind === "non_actionable_escalation" ||
    String(task.inProgressActionKind || "").startsWith("called") ||
    (task.appActionResults || []).some((a) => a.code === "open_phone")
  )
    return state("called", "progress", "phone");
  return state("needsAction", "action", "dot");
}
