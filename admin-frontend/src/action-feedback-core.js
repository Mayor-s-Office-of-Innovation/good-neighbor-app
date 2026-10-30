import {
  adminErrorMessage,
  creationConflictTitle,
} from "./admin-error-messages.js";
const reported = new WeakSet();
let operationSequence = 0;

/** Notifications belong to user operations, not individual API requests. */
const quietSuccess = new Set([
  "admin.toast.providerSaved",
  "admin.toast.providerManagerSaved",
  "admin.toast.staffSaved",
  "admin.toast.staffAdded",
  "admin.toast.siteSaved",
  "admin.toast.oversightSaved",
  "admin.toast.perimeterSaved",
  "admin.toast.managerSaved",
  "admin.profile.saved",
  "admin.toast.providerCreated",
  "admin.toast.programCreated",
  "admin.toast.optionCreated",
  "admin.toast.siteCreated",
  "admin.toast.programAssigned",
  "admin.toast.managerAssigned",
]);

export function createActionFeedback(successKey, showToast, t, inlineError) {
  const operationKey = `admin:${successKey}:${++operationSequence}`;
  let changed = false;
  let completed = false;
  let failed = false;
  let notification;
  return {
    changed() {
      changed = true;
    },
    success(key = successKey, tone = "success", params = {}) {
      completed = true;
      if (tone === "success" && quietSuccess.has(key)) return;
      notification?.close();
      notification = showToast({
        key: operationKey,
        title: t(key, params),
        message: "",
        tone,
        icon:
          tone === "success"
            ? "circle-check"
            : tone === "error"
              ? "circle-xmark"
              : "circle-info",
        duration: tone === "success" ? 3500 : 8000,
      });
    },
    failure(error, { inlineAvailable = true, message } = {}) {
      if (failed) return;
      failed = true;
      if (error && typeof error === "object") {
        if (reported.has(error)) return;
        reported.add(error);
      }
      // Correctable form/API validation stays beside the affected controls.
      if (
        inlineAvailable &&
        !changed &&
        !completed &&
        ([400, 422].includes(error?.status) ||
          (!error?.status &&
            [
              t("admin.programs.chooseStaff"),
              "lead_program_required",
              "invalid_file_size",
            ].includes(error?.message)))
      )
        return;
      notification?.close();
      const localMessage = completed
        ? `${t("admin.toast.refreshFailed")} ${t("admin.toast.refreshHelp")}`
        : changed
          ? `${t("admin.toast.partial")} ${t("admin.toast.partialHelp")}`
          : message || adminErrorMessage(error, t);
      if (
        inlineAvailable &&
        inlineError?.(localMessage, {
          key: operationKey,
          warning: changed || completed,
          ...(completed ? { duration: 5000 } : {}),
        })
      )
        return;
      if (!changed && !completed && creationConflictTitle(error)) {
        showToast({
          title: t(creationConflictTitle(error)),
          message: adminErrorMessage(error, t),
          tone: "error",
          icon: "circle-xmark",
          duration: 8000,
        });
        return;
      }
      const key = completed
        ? "admin.toast.refreshFailed"
        : changed
          ? "admin.toast.partial"
          : "admin.toast.failed";
      showToast({
        title: t(key),
        message:
          !changed && !completed && !inlineAvailable
            ? message || adminErrorMessage(error, t)
            : t(
                completed
                  ? "admin.toast.refreshHelp"
                  : changed
                    ? "admin.toast.partialHelp"
                    : "admin.toast.failureHelp",
              ),
        tone: completed || changed ? "info" : "error",
        icon: completed || changed ? "circle-info" : "circle-xmark",
        duration: 8000,
      });
    },
  };
}
