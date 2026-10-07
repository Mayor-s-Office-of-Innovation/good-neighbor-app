import { t } from "../i18n/i18n.js";

/** Shared action-type label, indicator tone, and status translation scope. */
export function taskRoute(task) {
  if (task?.kind === "escalation") {
    const ticketStatus = [
      "New",
      "Accepted",
      "Prioritized",
      "Closed",
      "In progress",
      "On hold",
      "Scheduled",
      "Deferred",
      "Open",
      "Sent",
    ].includes(task.ticketStatus || "")
      ? task.ticketStatus
      : "";
    const status = task.latestUpdateLabel || ticketStatus;
    return {
      label: t("card.route.ticket"),
      tone: "311",
      status,
      statusScope: task.latestUpdateLabel
        ? "server.taskUpdate"
        : "server.sf311",
      statusDetail: status ? task.ticketStatusDetail || "" : "",
      statusTone: task.ticketResponseOverdue
        ? "overdue"
        : status === "Closed"
          ? "closed"
          : "default",
    };
  }
  if (task?.kind === "non_actionable_escalation") {
    const emergency =
      task.inProgressActionKind === "called_911" ||
      (task.appActions || []).some(
        (action) =>
          action?.code === "open_phone" &&
          String(action?.payload?.phoneNumber || "").replace(/\D/g, "") ===
            "911",
      );
    return emergency
      ? {
          label: t("card.route.emergency"),
          tone: "emergency",
          status: task.latestUpdateLabel || "",
          statusScope: "server.taskUpdate",
          statusDetail: "",
          statusTone:
            task.latestUpdateLabel === "Resolved" ? "closed" : "default",
        }
      : {
          label: t("card.route.nonEmergency"),
          tone: "non-emergency",
          status: task.latestUpdateLabel || "",
          statusScope: "server.taskUpdate",
          statusDetail: "",
          statusTone:
            task.latestUpdateLabel === "Resolved" ? "closed" : "default",
        };
  }
  return { label: t("card.route.onsite"), tone: "onsite", status: "" };
}
