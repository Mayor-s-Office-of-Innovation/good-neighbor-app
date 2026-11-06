// Insights page shells. Loaded on first visit, so Manage never downloads them.
import "./insights.css";
import "./overview.view.js";
import "./raw-list.view.js";
import "./raw-record.view.js";
import "./site.view.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { carriedQuery, safeReturnPath } from "./insights-routes.js";
import { freshnessView } from "./insights.templates.js";

/** @param {string} segment a route id, still percent-encoded */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** @param {{ name: string, id: string }} route */
function pageTitle(route) {
  if (route.name === "insights-trends") return t("admin.insights.trends");
  if (route.name.startsWith("insights-")) return t("admin.insights.raw");
  return t("admin.insights.overview");
}

/** @param {string} label @param {string} id @param {[string, string, string, boolean][]} links key, label key, path, current @param {boolean} [leaf] false when a lower row holds the exact page */
function subnav(label, id, links, leaf = true) {
  return `<nav class="entity-tabs" ${id} aria-label="${escapeHtml(t(label))}">${links
    .map(
      ([key, labelKey, path, isCurrent]) =>
        `<a href="${escapeHtml(path)}" data-route ${key} ${isCurrent ? currentAttribute(path, leaf) : ""}>${escapeHtml(t(labelKey))}</a>`,
    )
    .join("")}</nav>`;
}

// A section holding the page is "true", so screen readers name one current page.
/** @param {string} path @param {boolean} leaf */
function currentAttribute(path, leaf) {
  const here = window.location.pathname.replace(/\/$/, "");
  return `aria-current="${leaf && path.split("?")[0] === here ? "page" : "true"}"`;
}

/** @param {{ name: string, id: string }} route @param {string} search filters included */
export function insightsPageView(route, search) {
  const query = carriedQuery(search);
  const raw = /^insights-(issue|check)s?$/.test(route.name);
  const checks = route.name.startsWith("insights-check");
  // A record replaces the list, as the mock's do, so it has no list tabs.
  const record =
    route.name === "insights-issue" || route.name === "insights-check";
  const section =
    route.name === "insights-trends" ? "trends" : raw ? "raw" : "overview";
  // Past the length cap the return would be refused, so keep the period then.
  const here =
    safeReturnPath(`${window.location.pathname}${search}`) ||
    `${window.location.pathname}${query}`;
  return `<section class="insights" id="insights-page" aria-labelledby="insights-title">
    ${subnav(
      "admin.insights.navLabel",
      'id="insights-nav"',
      [
        [
          'data-insights-nav="overview"',
          "admin.insights.overview",
          `/insights${query}`,
          section === "overview",
        ],
        [
          'data-insights-nav="raw"',
          "admin.insights.raw",
          `/insights/raw/issues${query}`,
          section === "raw",
        ],
        [
          'data-insights-nav="trends"',
          "admin.insights.trends",
          `/insights/trends${query}`,
          section === "trends",
        ],
      ],
      !raw,
    )}
    ${
      // Raw data draws its own title row, for Export CSV; Site and record pages name what only their data knows.
      raw || route.name === "insights-site"
        ? ""
        : `<div class="page-head"><h1 id="insights-title" tabindex="-1">${escapeHtml(pageTitle(route))}</h1></div>`
    }
    ${route.name === "insights-trends" ? freshnessView(null) : ""}
    ${
      route.name === "insights"
        ? "<insights-overview></insights-overview>"
        : route.name === "insights-site"
          ? `<insights-site data-site-id="${escapeHtml(decodeSegment(route.id))}" data-here="${escapeHtml(here)}"></insights-site>`
          : record
            ? `<insights-record data-kind="${checks ? "check" : "issue"}" data-id="${escapeHtml(decodeSegment(route.id))}" data-here="${escapeHtml(here)}"></insights-record>`
            : raw
              ? `<insights-raw-list data-kind="${checks ? "checks" : "issues"}"></insights-raw-list>`
              : `<p class="empty-state">${escapeHtml(t("admin.insights.notReady"))}</p>`
    }
  </section>`;
}
