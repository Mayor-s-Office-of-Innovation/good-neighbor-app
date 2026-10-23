import { localizedAnalyzerText } from "../i18n/analyzer.js";
import { rulebookText } from "../i18n/rulebook.js";
import { t } from "../i18n/i18n.js";

/**
 * The title a home card shows for a task, in the active locale. Shared with
 * the surfaces that refer back to a card (the results prompt, the 311 toast)
 * so they name the card the way the list does.
 * @param {Record<string, any> | null | undefined} task
 * @returns {string}
 */
export function taskCardTitle(task) {
  return (
    localizedAnalyzerText(
      task,
      task?.userFriendlyLabel,
      "user_friendly_label",
    ) ||
    task?.userFriendlyLabel ||
    task?.user_friendly_label ||
    rulebookText(task?.category) ||
    rulebookText(task?.analyzerCategory) ||
    rulebookText(task?.canonicalCategory) ||
    rulebookText(task?.label) ||
    t("card.title.fallback")
  );
}
