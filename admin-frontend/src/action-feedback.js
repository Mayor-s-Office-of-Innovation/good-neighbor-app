import { showInlineError } from "../../frontend/src/components/error-notice.js";
import { showToast } from "../../frontend/src/state/toasts.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import { createActionFeedback } from "./action-feedback-core.js";

export function actionFeedback(key) {
  return createActionFeedback(key, showToast, t, showInlineError);
}

export function notifyAdmin(key, tone = "success", params = {}) {
  return actionFeedback(key).success(key, tone, params);
}
