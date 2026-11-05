// <insights-site>: one Site's counts and Issues for the period, with links to Manage and back.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { adminApi } from "../../services/admin-api.js";
import {
  overviewSearch,
  periodApiParams,
  periodSearch,
  readOverview,
  readPeriod,
  samePeriod,
} from "./insights-query.js";
import { carriedQuery, safeReturnPath } from "./insights-routes.js";
import { sessionOf } from "./insights-session.js";
import {
  drawPeriodControl,
  failedView,
  failureText,
  freshnessView,
  loadingView,
  periodClicked,
} from "./insights.templates.js";
import {
  siteBodyView,
  siteHeadView,
  siteIssuesView,
  siteLinksView,
} from "./site.templates.js";

/** @typedef {import("./insights-query.js").Period} Period */

/** @param {string} path */
const isOverview = (path) =>
  path.split("?")[0].replace(/\/$/, "") === "/insights";

/** Keeps Overview's filters but shows the period picked here, as the tabs do. @param {string} path @param {Period | null} period */
function withPeriod(path, period) {
  const query = `?${path.split("?")[1] ?? ""}`;
  if (samePeriod(readPeriod(query), period)) return path;
  // A new period has new pages and rows, so the old page and picks go.
  // Built as Overview builds its own URL, so Overview knows it on return.
  const state = { ...readOverview(query), cursor: "", selected: [] };
  return `/insights${overviewSearch(state, period)}`;
}

class InsightsSite extends HTMLElement {
  connectedCallback() {
    this.session = sessionOf(this);
    this.siteId = this.dataset.siteId ?? "";
    /** @type {Period | null} */
    this.period = readPeriod(location.search);
    this.periodKind = this.period?.kind ?? "month";
    this.periodError = "";
    /** @type {Record<string, any> | null} */
    this.reply = null;
    /** @type {Record<string, any> | null} */
    this.issues = null;
    this.issuesFailed = "";
    /** @type {Map<string, string>} */
    this.managerNames = new Map();
    this.generation = 0;
    // Opened from Overview, the next Overview link goes back to that view.
    const asked = safeReturnPath(
      new URLSearchParams(location.search).get("return"),
    );
    // Paging history belongs to one Overview; another one starts without it.
    if (isOverview(asked))
      this.session.overview = {
        path: asked,
        siteId: this.siteId,
        pages:
          asked === this.session.overview.path
            ? this.session.overview.pages
            : [],
        alsoPath: "",
      };
    this.urls = this.links();
    // The heading is drawn now, so the dashboard can focus it on arrival.
    this.innerHTML = `
      <div data-region="head">${siteHeadView({ site: null, siteId: this.siteId, names: this.managerNames })}</div>
      <div data-region="links">${siteLinksView(this.urls)}</div>
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="period"></div>
      <div data-region="body"></div>
      <section class="insights__group" data-region="issues" aria-labelledby="insights-site-issues">${siteIssuesView({ issues: null, failed: "", issueHref: () => "" })}</section>`;
    this.addEventListener("click", this.clicked);
    this.drawPeriod();
    void this.loadNames();
    void this.load();
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.removeEventListener("click", this.clicked);
  }

  /** @param {string} name @returns {HTMLElement} */
  region(name) {
    return /** @type {HTMLElement} */ (
      this.querySelector(`[data-region="${name}"]`)
    );
  }

  /** Back goes to the Overview this Site came from, else the last one seen. */
  links() {
    const asked = safeReturnPath(
      new URLSearchParams(location.search).get("return"),
    );
    const remembered = safeReturnPath(this.session.overview.path);
    const back = withPeriod(
      (isOverview(asked) && asked) ||
        (isOverview(remembered) && remembered) ||
        "/insights",
      this.period,
    );
    const here = this.dataset.here ?? location.pathname;
    const id = encodeURIComponent(this.siteId);
    const raw = new URLSearchParams(carriedQuery(location.search));
    raw.set("siteIds", this.siteId);
    const ret = encodeURIComponent(here);
    return {
      back,
      manage: `/sites/${id}?return=${ret}`,
      contacts: `/sites/${id}?section=details&return=${ret}`,
      raw: `/insights/raw/issues?${raw}`,
    };
  }

  /** Overview finds its place by exact path, so a Back at a new period is noted too. */
  rememberBack() {
    const overview = this.session.overview;
    if (overview.siteId !== this.siteId) return;
    overview.alsoPath = this.urls.back === overview.path ? "" : this.urls.back;
  }

  async loadNames() {
    try {
      const names = await this.session.names();
      if (!this.isConnected) return;
      this.managerNames = names.managerId;
      if (this.reply) this.drawHead();
    } catch {
      // The manager's ID shows instead of a name.
    }
  }

  /** @param {Record<string, string>} params @param {AbortSignal} signal */
  readIssues(params, signal) {
    return adminApi
      .reportingIssues({ ...params, siteIds: this.siteId }, signal)
      .then(
        (reply) => ({ reply, error: null }),
        (error) => ({ reply: null, error }),
      );
  }

  async load() {
    const mine = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const params = periodApiParams(this.period);
    this.region("body").innerHTML = loadingView();
    this.region("issues").hidden = false;
    this.issues = null;
    this.issuesFailed = "";
    this.drawIssues();
    this.setAttribute("aria-busy", "true");
    // Both at once; the Issue list can fail alone and keep the counts.
    const issues = this.readIssues(params, signal);
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await adminApi.reportingSite(this.siteId, params, signal);
    } catch (err) {
      if (
        mine !== this.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      this.removeAttribute("aria-busy");
      this.reply = null;
      // The old data time is for another period; Issues need their Site.
      this.region("freshness").innerHTML = freshnessView(null);
      this.drawHead();
      this.region("issues").hidden = true;
      this.region("body").innerHTML =
        // Other 404s, such as a route the API lacks, are plain failures.
        /** @type {any} */ (err)?.message === "site_not_found"
          ? `<p class="empty-state" data-insights-empty="site">${escapeHtml(t("admin.insights.siteNotFound"))}</p>`
          : failedView(failureText(err, t("admin.insights.siteFailed")));
      // The period controls step from the period asked for instead.
      this.drawPeriod();
      return;
    }
    const listed = await issues;
    if (mine !== this.generation) return;
    this.removeAttribute("aria-busy");
    this.reply = reply;
    this.drawHead();
    this.region("freshness").innerHTML = freshnessView(reply.meta);
    this.drawPeriod();
    this.region("body").innerHTML = siteBodyView({
      reply,
      contactsHref: this.urls.contacts,
    });
    this.issuesLoaded(listed);
  }

  /** @param {{ reply: Record<string, any> | null, error: unknown }} listed */
  issuesLoaded(listed) {
    this.issues = listed.reply;
    this.issuesFailed = listed.error
      ? failureText(listed.error, t("admin.insights.issuesFailed"))
      : "";
    this.drawIssues();
  }

  /** Only the list failed, so the counts above stay on screen. */
  async retryIssues() {
    const mine = this.generation;
    this.issuesFailed = "";
    this.drawIssues();
    // The Retry button just went; the heading holds focus while it loads.
    this.region("issues").insertAdjacentHTML("beforeend", loadingView());
    /** @type {HTMLElement | null} */ (
      this.querySelector("#insights-site-issues")
    )?.focus();
    const listed = await this.readIssues(
      periodApiParams(this.period),
      /** @type {AbortController} */ (this.controller).signal,
    );
    if (mine !== this.generation) return;
    const heading = this.querySelector("#insights-site-issues");
    // A user who moved on while it loaded keeps their place.
    const waiting = document.activeElement === heading;
    this.issuesLoaded(listed);
    if (waiting)
      /** @type {HTMLElement | null} */ (
        this.querySelector("#insights-site-issues")
      )?.focus();
  }

  drawHead() {
    const focused = document.activeElement?.id === "insights-title";
    this.region("head").innerHTML = siteHeadView({
      site: this.reply?.site ?? null,
      siteId: this.siteId,
      names: this.managerNames,
    });
    // The dashboard focused the placeholder heading on arrival.
    if (focused)
      /** @type {HTMLElement} */ (this.querySelector("#insights-title")).focus({
        preventScroll: true,
      });
  }

  drawIssues() {
    this.region("issues").innerHTML = siteIssuesView({
      issues: this.issues,
      failed: this.issuesFailed,
      issueHref: (issue) => {
        const query = new URLSearchParams(carriedQuery(location.search));
        // Two Sites can share an Issue ID, so the record needs its Site.
        query.set("siteId", issue.siteId);
        query.set("return", this.dataset.here ?? location.pathname);
        return `/insights/raw/issues/${encodeURIComponent(issue.issueId)}?${query}`;
      },
    });
  }

  drawPeriod() {
    drawPeriodControl(this, this.region("period"));
  }

  /** @param {Period} period */
  periodPicked(period) {
    this.period = period;
    this.periodKind = period.kind;
    this.periodError = "";
    const params = new URLSearchParams(location.search);
    const next = periodSearch(period);
    const back = params.get("return");
    if (back) next.set("return", back);
    const path = `${location.pathname}?${next}`;
    history.replaceState(history.state, "", path);
    this.dataset.here = safeReturnPath(path) || location.pathname;
    this.dispatchEvent(new CustomEvent("insights-url", { bubbles: true }));
    this.urls = this.links();
    this.rememberBack();
    this.region("links").innerHTML = siteLinksView(this.urls);
    this.drawPeriod();
    void this.load();
  }

  /** @param {Event} event */
  clicked = (event) => {
    const button = /** @type {Element} */ (event.target).closest("button");
    if (!button || !this.contains(button)) return;
    if (button.id === "insights-retry") return void this.load();
    if (button.id === "insights-issues-retry") return void this.retryIssues();
    if (this.region("period").contains(button))
      periodClicked(this, button, this.region("period"));
  };
}

if (!customElements.get("insights-site"))
  customElements.define("insights-site", InsightsSite);
