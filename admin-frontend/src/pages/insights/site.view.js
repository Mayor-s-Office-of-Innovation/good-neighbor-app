// <insights-site>: one Site's concerns, contacts, activity, severe Issues and Issue responses for the period.
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
  showLoaded,
  showLoading,
  periodClicked,
  periodInterval,
  periodName,
  rangeLabel,
} from "./insights.templates.js";
import {
  contactsView,
  SITE_LISTS,
  siteBodyView,
  siteTopView,
  siteHeadView,
  siteIssuesView,
  sitePeriodView,
} from "./site.templates.js";

/** @typedef {import("./insights-query.js").Period} Period */
/** @typedef {import("./site.templates.js").SiteList} SiteList */
/** @typedef {{ tile: string, issues: Record<string, any> | null, failed: string, generation: number }} ListState */

const LISTS = /** @type {SiteList[]} */ (Object.keys(SITE_LISTS));

/** @param {string} path */
const isOverview = (path) =>
  path.split("?")[0].replace(/\/$/, "") === "/insights";

/** Keeps Overview's filters but shows the period picked here, as the tabs do. @param {string} path @param {Period | null} period */
function withPeriod(path, period) {
  const query = `?${path.split("?")[1] ?? ""}`;
  if (samePeriod(readPeriod(query), period)) return path;
  // Built as Overview builds its own URL, so Overview knows it on return.
  return `/insights${overviewSearch(readOverview(query), period)}`;
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
    // Each section's own picks and list, so changing one doesn't reload the other.
    /** @type {Record<SiteList, ListState>} */
    this.lists = /** @type {any} */ (
      Object.fromEntries(
        LISTS.map((list) => [
          list,
          { tile: "", issues: null, failed: "", generation: 0 },
        ]),
      )
    );
    /** @type {SiteList} the list the open panel's Issue came from */
    this.panelList = "response";
    /** @type {Map<string, string>} */
    this.managerNames = new Map();
    this.generation = 0;
    // Opened from Overview, the next Overview link goes back to that view.
    const asked = safeReturnPath(
      new URLSearchParams(location.search).get("return"),
    );
    // Picks belong to one Overview; another one starts without them.
    if (isOverview(asked))
      this.session.overview = {
        path: asked,
        siteId: this.siteId,
        selected:
          asked === this.session.overview.path
            ? this.session.overview.selected
            : [],
        alsoPath: "",
      };
    this.urls = this.links();
    const interval = periodInterval(this);
    // The heading is drawn now, so the dashboard can focus it on arrival.
    this.innerHTML = `
      <div data-region="head">${this.headView()}</div>
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="top"></div>
      <div data-region="period">${sitePeriodView({ label: periodName(interval), range: interval ? rangeLabel(interval) : "" })}</div>
      <div data-region="body"></div>
      <footer data-region="footer"></footer>`;
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
    for (const list of LISTS) this.lists[list].generation++;
    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;
    const params = periodApiParams(this.period);
    showLoading(this.region("body"));
    // The old interval is for the period no longer shown.

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
      this.region("top").innerHTML = "";
      showLoaded(
        this.region("body"), // Other 404s, such as a route the API lacks, are plain failures.
        /** @type {any} */ (err)?.message === "site_not_found"
          ? `<p class="empty-state" data-insights-empty="site">${escapeHtml(t("admin.insights.siteNotFound"))}</p>`
          : failedView(failureText(err, t("admin.insights.siteFailed"))),
      );
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
    this.region("top").innerHTML = siteTopView({
      reply,
      details: this.details,
      hrefs: this.urls,
    });
    showLoaded(
      this.region("body"),
      siteBodyView({
        reply,
        tiles: {
          severity: this.lists.severity.tile,
          response: this.lists.response.tile,
        },
        hrefs: this.urls,
      }),
    );
    for (const list of LISTS)
      void this.loadIssues(list, back?.list === list ? back.issueId : "");
  }

  /** @param {SiteList} list @returns {HTMLElement | null} */
  issuesRegion(list) {
    return this.querySelector(`[data-list="${list}"] [data-region="issues"]`);
  }

  /**
   * Lists the selected tiles' Issues; a failure here keeps the counts above.
   * @param {SiteList} list
   * @param {string} [focusId] the Issue to land on, coming back
   */
  async loadIssues(list, focusId = "") {
    const state = this.lists[list];
    const mine = ++state.generation;
    state.issues = null;
    state.failed = "";
    this.drawIssues(list);
    const region = this.issuesRegion(list);
    if (!state.tile || !region) return;
    region.insertAdjacentHTML("beforeend", loadingView());
    try {
      const issues = await adminApi.reportingIssues(
        {
          ...periodApiParams(this.period),
          siteIds: this.siteId,
          [SITE_LISTS[list].param]: state.tile,
        },
        /** @type {AbortController} */ (this.controller).signal,
      );
      if (mine !== state.generation) return;
      state.issues = issues;
    } catch (err) {
      if (
        mine !== state.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      state.failed = failureText(err, t("admin.insights.issuesFailed"));
    }
    this.drawIssues();
  }

  /** @param {SiteList} list */
  drawIssues(list) {
    const region = this.issuesRegion(list);
    if (!region) return;
    const state = this.lists[list];
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

  /** Each tile adds or removes its value from its own list. @param {SiteList} list @param {string} tile */
  pickTile(list, tile) {
    if (!this.reply) return;
    const state = this.lists[list];
    const on = new Set(state.tile.split(",").filter(Boolean));
    if (!on.delete(tile)) on.add(tile);
    // Tile order, so the same picks make the same URL and request.
    state.tile = SITE_LISTS[list].tiles.filter((key) => on.has(key)).join(",");
    for (const button of this.querySelectorAll(
      `[data-list="${list}"] [data-tile]`,
    ))
      button.setAttribute(
        "aria-pressed",
        `${on.has(button.getAttribute("data-tile") ?? "")}`,
      );
    void this.loadIssues(list);
  }

  /** @param {Element} element @returns {SiteList | undefined} */
  listOf(element) {
    const list = element.closest("[data-list]")?.getAttribute("data-list");
    return LISTS.find((name) => name === list);
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
    if (label) label.textContent = periodName(interval);
    const range = this.querySelector("[data-period-range]");
    if (range) range.textContent = interval ? rangeLabel(interval) : "";
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
    const list = this.listOf(button);
    if (list && button.id === SITE_LISTS[list].retry)
      return void this.loadIssues(list);
    const tile = button.getAttribute("data-tile");
    if (list && tile) return this.pickTile(list, tile);
    if (this.periodBody().contains(button))
      periodClicked(this, button, this.periodBody());
  };
}

if (!customElements.get("insights-site"))
  customElements.define("insights-site", InsightsSite);
