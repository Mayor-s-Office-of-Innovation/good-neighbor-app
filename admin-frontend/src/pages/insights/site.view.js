// <insights-site>: one Site's concerns, contacts, activity and Issue responses for the period.
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
  periodInterval,
  periodLabel,
  rangeLabel,
} from "./insights.templates.js";
import {
  contactsView,
  firstTile,
  siteBodyView,
  siteHeadView,
  siteIssuesView,
  sitePeriodView,
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
    /** @type {import("./site.templates.js").ContactDetails} */
    this.details = null;
    /** @type {Record<string, any> | null} */
    this.issues = null;
    this.issuesFailed = "";
    this.tile = "";
    /** @type {Map<string, string>} */
    this.managerNames = new Map();
    this.generation = 0;
    this.issuesGeneration = 0;
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
    const interval = periodInterval(this);
    // The heading is drawn now, so the dashboard can focus it on arrival.
    this.innerHTML = `
      <div data-region="head">${this.headView()}</div>
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="period">${sitePeriodView({ label: periodLabel(interval), range: rangeLabel(interval) })}</div>
      <div data-region="body"></div>`;
    this.addEventListener("click", this.clicked);
    this.drawPeriod();
    void this.loadNames();
    void this.loadDetails();
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

  /** @returns {HTMLElement} */
  periodBody() {
    return /** @type {HTMLElement} */ (
      this.querySelector("[data-period-body]")
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
    const id = encodeURIComponent(this.siteId);
    /** @param {string} kind */
    const raw = (kind) => {
      const query = new URLSearchParams(carriedQuery(location.search));
      query.set("siteIds", this.siteId);
      return `/insights/raw/${kind}?${query}`;
    };
    return {
      back,
      // A new tab, so this page stays where it was.
      contacts: `/sites/${id}?section=details`,
      issues: raw("issues"),
      checks: raw("checks"),
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

  /** Contact details are today's and don't change with the period, so they're read once. */
  async loadDetails() {
    try {
      const { items } = await adminApi.getSite(this.siteId);
      if (!this.isConnected) return;
      this.details =
        (items ?? []).find((/** @type {any} */ item) => item.sk === "#META") ??
        null;
      this.drawContacts();
    } catch {
      // Without the record, each contact shows its state alone.
    }
  }

  drawContacts() {
    const region = this.querySelector('[data-region="contacts"]');
    if (region && this.reply)
      region.innerHTML = contactsView({
        reply: this.reply,
        details: this.details,
      });
  }

  async load() {
    const mine = ++this.generation;
    this.issuesGeneration++;
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const params = periodApiParams(this.period);
    this.region("body").innerHTML = loadingView();
    this.setAttribute("aria-busy", "true");
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
      // The old data time is for another period.
      this.region("freshness").innerHTML = freshnessView(null);
      this.drawHead();
      this.region("body").innerHTML =
        // Other 404s, such as a route the API lacks, are plain failures.
        /** @type {any} */ (err)?.message === "site_not_found"
          ? `<p class="empty-state" data-insights-empty="site">${escapeHtml(t("admin.insights.siteNotFound"))}</p>`
          : failedView(failureText(err, t("admin.insights.siteFailed")));
      // The period controls step from the period asked for instead.
      this.drawPeriod();
      return;
    }
    if (mine !== this.generation) return;
    this.removeAttribute("aria-busy");
    this.reply = reply;
    this.tile = firstTile(reply);
    this.drawHead();
    this.region("freshness").innerHTML = freshnessView(reply.meta);
    this.drawPeriod();
    this.region("body").innerHTML = siteBodyView({
      reply,
      details: this.details,
      tile: this.tile,
      hrefs: this.urls,
    });
    void this.loadIssues();
  }

  /** Lists the selected tile's Issues; a failure here keeps the counts above. */
  async loadIssues() {
    const mine = ++this.issuesGeneration;
    this.issues = null;
    this.issuesFailed = "";
    this.drawIssues();
    if (!this.tile || !this.region("issues")) return;
    this.region("issues").insertAdjacentHTML("beforeend", loadingView());
    try {
      const issues = await adminApi.reportingIssues(
        {
          ...periodApiParams(this.period),
          siteIds: this.siteId,
          responseState: this.tile,
        },
        /** @type {AbortController} */ (this.controller).signal,
      );
      if (mine !== this.issuesGeneration) return;
      this.issues = issues;
    } catch (err) {
      if (
        mine !== this.issuesGeneration ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      this.issuesFailed = failureText(err, t("admin.insights.issuesFailed"));
    }
    this.drawIssues();
  }

  drawIssues() {
    const region = this.region("issues");
    if (!region) return;
    region.innerHTML = siteIssuesView({
      issues: this.issues,
      failed: this.issuesFailed,
      tile: this.tile,
      issueHref: (issue) => {
        const query = new URLSearchParams(carriedQuery(location.search));
        // Two Sites can share an Issue ID, so the record needs its Site.
        query.set("siteId", issue.siteId);
        query.set("return", this.dataset.here ?? location.pathname);
        return `/insights/raw/issues/${encodeURIComponent(issue.issueId)}?${query}`;
      },
    });
  }

  /** Pressing the selected tile again closes its list, as the mock does. @param {string} tile */
  pickTile(tile) {
    if (!this.reply) return;
    this.tile = tile === this.tile ? "" : tile;
    for (const button of this.querySelectorAll("[data-tile]"))
      button.setAttribute(
        "aria-pressed",
        `${button.getAttribute("data-tile") === this.tile}`,
      );
    void this.loadIssues();
  }

  headView() {
    return siteHeadView({
      site: this.reply?.site ?? null,
      siteId: this.siteId,
      names: this.managerNames,
      back: this.urls.back,
    });
  }

  drawHead() {
    const focused = document.activeElement?.id === "insights-title";
    this.region("head").innerHTML = this.headView();
    // The dashboard focused the placeholder heading on arrival.
    if (focused)
      /** @type {HTMLElement} */ (this.querySelector("#insights-title")).focus({
        preventScroll: true,
      });
  }

  drawPeriod() {
    const interval = periodInterval(this);
    const label = this.querySelector("[data-period-button]");
    if (label) label.textContent = periodLabel(interval);
    const range = this.querySelector("[data-period-range]");
    if (range) range.textContent = rangeLabel(interval);
    drawPeriodControl(this, this.periodBody());
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
    this.drawHead();
    this.drawPeriod();
    void this.load();
  }

  /** @param {Event} event */
  clicked = (event) => {
    const button = /** @type {Element} */ (event.target).closest("button");
    if (!button || !this.contains(button)) return;
    if (button.id === "insights-retry") return void this.load();
    if (button.id === "insights-issues-retry") return void this.loadIssues();
    const tile = button.getAttribute("data-tile");
    if (tile) return this.pickTile(tile);
    const jump = button.getAttribute("data-jump-tile");
    if (jump) {
      if (jump !== this.tile) this.pickTile(jump);
      /** @type {HTMLElement | null} */ (
        this.querySelector(`[data-tile="${CSS.escape(jump)}"]`)
      )?.focus();
      return;
    }
    if (this.periodBody().contains(button))
      periodClicked(this, button, this.periodBody());
  };
}

if (!customElements.get("insights-site"))
  customElements.define("insights-site", InsightsSite);
