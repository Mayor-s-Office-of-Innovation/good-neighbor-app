import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { MODE_HOME, carriedQuery } from "./insights-routes.js";

/** @param {"insights" | "manage" | ""} mode @param {(mode: "insights" | "manage") => string} href where a tab reopens */
export function modeNav(mode, href) {
  // Clicking the open tab is how users get back to its start page; Insights keeps the period.
  const home = (/** @type {"insights" | "manage"} */ name) =>
    name === "insights"
      ? `${MODE_HOME.insights}${carriedQuery(location.search)}`
      : MODE_HOME.manage;
  const tab = (/** @type {"insights" | "manage"} */ name) =>
    `<a href="${escapeHtml(name === mode ? home(name) : href(name))}" data-route data-mode="${name}" ${name === mode ? 'aria-current="true"' : ""}>${escapeHtml(t(`admin.modes.${name}`))}</a>`;
  return `<nav class="entity-tabs" id="admin-modes" aria-label="${escapeHtml(t("admin.modes.label"))}">${tab("manage")}${tab("insights")}</nav>`;
}

/** @param {string} path a path already checked by safeReturnPath */
export function insightsReturnLink(path) {
  return path
    ? `<a class="site-back-link" id="insights-return" href="${escapeHtml(path)}" data-route><wa-icon name="chevron-left" aria-hidden="true"></wa-icon> ${escapeHtml(t("admin.insights.back"))}</a>`
    : "";
}
