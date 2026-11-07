// The Insights pages. Small, since Manage loads it; the page shells download on first visit.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { appMessageError } from "../../admin-error-messages.js";
import { getAdminConfig } from "../../config.js";
import { currentRoute, navigate } from "../../router.js";
import {
  MODE_HOME,
  carriedQuery,
  redirectTarget,
  routeMode,
} from "./insights-routes.js";
import { insightsAvailable } from "./mode-memory.js";
import { insightsOffView } from "./shell.templates.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 */

// An object, so a test can make the download fail or stall.
export const insightsDownload = {
  /** @returns {Promise<typeof import("./insights.pages.js")>} */
  start: () => import("./insights.pages.js"),
};

/** @param {AdminSession} session @returns {boolean} */
export function insightsOn(session) {
  return insightsAvailable(getAdminConfig(), session.capabilities);
}

// Bookmarks outlive the deploy switch, so its pages say why rather than silently open Sites.
/** @param {Route} route @returns {boolean} */
function showsOffNotice(route) {
  return (
    !getAdminConfig().insightsEnabled &&
    (route.name === "analytics" || routeMode(route.name) === "insights")
  );
}

export class AdminInsightsPage extends HTMLElement {
  /** @type {typeof import("./insights.pages.js") | null} */
  views = null;
  /** @type {Promise<typeof import("./insights.pages.js")> | null} */
  viewsLoad = null;
  viewsLoadFailed = false;
  // Set before open() by <admin-app>'s createPage().
  /** @type {AdminSession} */
  session = /** @type {any} */ (null);

  connectedCallback() {
    this.addEventListener("insights-url", this.urlChanged);
    this.render();
  }

  disconnectedCallback() {
    this.removeEventListener("insights-url", this.urlChanged);
  }

  // <admin-app> notes the new URL for Back and tab memory; the tabs carry its period, so switching pages keeps it.
  urlChanged = () => {
    const query = carriedQuery(location.search);
    for (const link of this.querySelectorAll(
      "#insights-page [data-insights-nav], #insights-page [data-insights-raw]",
    )) {
      const path = (link.getAttribute("href") ?? "").split("?")[0];
      link.setAttribute("href", `${path}${query}`);
    }
    this.dispatchEvent(
      new CustomEvent("page-rendered", {
        bubbles: true,
        detail: location.pathname + location.search,
      }),
    );
  };

  /** @param {Route} route @returns {Promise<boolean>} false if the user left or it redirects */
  async open(route) {
    const path = location.pathname + location.search;
    if (showsOffNotice(route)) return true;
    if (!insightsOn(this.session)) {
      navigate("/sites", { replace: true });
      return false;
    }
    // Insights replaced Analytics, so its bookmarks open Insights.
    if (route.name === "analytics") {
      navigate(MODE_HOME.insights, { replace: true });
      return false;
    }
    const target = redirectTarget(route.name, location.search);
    if (target) {
      navigate(target, { replace: true });
      return false;
    }
    if (this.views) return true;
    // Browsers keep a failed import's error, so only a fresh page load retries it.
    if (this.viewsLoadFailed) {
      location.reload();
      return false;
    }
    // Shared, so a second click while the first download runs doesn't start another.
    this.viewsLoad ??= insightsDownload.start().catch(() => {
      this.viewsLoadFailed = true;
      this.viewsLoad = null;
      // The raw import error names a hashed file, which tells an admin nothing.
      throw appMessageError(t("admin.insights.loadError"));
    });
    this.views = await this.viewsLoad;
    return location.pathname + location.search === path;
  }

  /** @param {Route} route */
  shows(route) {
    if (showsOffNotice(route)) return true;
    return Boolean(this.views) && routeMode(route.name) === "insights";
  }

  focusOnOpen() {
    /** @type {HTMLElement | null} */ (
      this.querySelector("#insights-title")
    )?.focus();
  }

  render() {
    const route = currentRoute();
    if (showsOffNotice(route)) {
      this.innerHTML = insightsOffView();
      return;
    }
    this.innerHTML =
      this.views && this.shows(route)
        ? this.views.insightsPageView(
            /** @type {{ name: string, id: string }} */ (route),
            location.search,
          )
        : "";
  }
}

customElements.define("admin-insights-page", AdminInsightsPage);
