const reported = new WeakSet();

/** Notifications belong to user operations, not individual API requests. */
export function createActionFeedback(successKey, showToast, t) {
  let changed = false;
  let completed = false;
  let failed = false;
  let notification;
  return {
    changed() {
      changed = true;
    },
    success(key = successKey, tone = "success", params = {}) {
      completed = tone !== "error";
      notification = showToast({
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
    failure(error) {
      if (failed) return;
      failed = true;
      if (error && typeof error === "object") {
        if (reported.has(error)) return;
        reported.add(error);
      }
      // Correctable form/API validation stays beside the affected controls.
      if (
        !changed &&
        !completed &&
        ([400, 409, 422].includes(error?.status) ||
          error?.message === t("admin.programs.chooseStaff") ||
          /required|invalid|Choose |chooseStaff/.test(error?.message || ""))
      )
        return;
      notification?.close();
      const key = completed
        ? "admin.toast.refreshFailed"
        : changed
          ? "admin.toast.partial"
          : "admin.toast.failed";
      showToast({
        title: t(key),
        message: t(
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
