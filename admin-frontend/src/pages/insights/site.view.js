// <insights-site>: one Site's concerns, contacts, activity, severe Issues and Issue responses for the period.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../../dom.js";
import { adminApi } from "../../services/admin-api.js";
import { periodApiParams, periodSearch, readPeriod } from "./insights-query.js";
import { safeReturnPath } from "./insights-routes.js";
import { reportSignInError, sessionOf } from "./insights-session.js";
import { LatestLoad, superseded } from "./latest-load.js";
import {
  drawPeriodControl,
  incompletePill,
  failedView,
  failureText,
  freshnessView,
  loadingView,
  monthOfToday,
  showLoaded,
  showLoading,
  periodClicked,
  periodInterval,
  periodName,
  rangeLabel,
} from "./insights.templates.js";
import {
  alsoPath,
  backPath,
  isOverview,
  listFilter,
  toggleTile,
} from "./site-rules.js";
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
/**
 * concern: a concern's own list, shown instead of the tiles' until a tile is picked.
 * more: "", "loading", or why the last Load more failed.
 * @typedef {{ tile: string, concern: string, issues: Record<string, any> | null, failed: string, more: string, generation: number, controller?: AbortController }} ListState
 */

const LISTS = /** @type {SiteList[]} */ (Object.keys(SITE_LISTS));

/** A plain left click; any other opens the link's own address, as links do. @param {MouseEvent} event */
const plainClick = (event) =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;

class InsightsSite extends HTMLElement {
  connectedCallback() {
    this.session = sessionOf(this);
    this.siteId = this.dataset.siteId ?? "";
    /** @type {Period | null} */
    this.period = readPeriod(location.search);
    this.periodKind = this.period?.kind ?? "month";
    this.periodError = "";
    /** @type {Period | null} */
    this.fallback = null;
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
          {
            tile: "",
            concern: "",
            issues: null,
            failed: "",
            more: "",
            generation: 0,
          },
        ]),
      )
    );
    /** @type {Map<string, string>} */
    this.managerNames = new Map();
    this.loads = new LatestLoad();
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
    this.rememberBack();
    const interval = periodInterval(this);
    // The heading is drawn now, so the dashboard can focus it on arrival.
    this.innerHTML = `
      <div data-region="head">${this.headView()}</div>
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="top"></div>
      <div data-region="period">${sitePeriodView({ label: periodName(interval), range: interval ? rangeLabel(interval) : "" })}</div>
      <div data-region="body"></div>
`;
    this.addEventListener("click", this.clicked);
    this.drawPeriod();
    void this.loadNames();
    void this.loadDetails();
    void this.load();
  }

  disconnectedCallback() {
    this.loads?.abort();
    for (const list of LISTS) this.lists[list].controller?.abort();
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

  links() {
    return {
      back: backPath({
        asked: safeReturnPath(
          new URLSearchParams(location.search).get("return"),
        ),
        remembered: safeReturnPath(this.session.overview.path),
        period: this.period,
      }),
      // A new tab, so this page stays where it was.
      contacts: `/sites/${encodeURIComponent(this.siteId)}?section=details`,
    };
  }

  rememberBack() {
    const overview = this.session.overview;
    if (overview.siteId !== this.siteId) return;
    overview.alsoPath = alsoPath(overview.path, this.urls.back);
  }

  async loadNames() {
    try {
      const names = await this.session.names();
      if (!this.isConnected) return;
      this.managerNames = names.managerId;
      if (this.reply) this.drawHead();
    } catch (err) {
      reportSignInError(this, err);
      // The manager's ID shows instead of a name.
    }
  }

  /** Contact details are today's and don't change with the period, so they're read once. */
  async loadDetails() {
    try {
      // Settings reads the Site's own record only, not its letters or staff.
      const { items } = await adminApi.getSite(this.siteId, false, "settings");
      if (!this.isConnected) return;
      this.details =
        (items ?? []).find((/** @type {any} */ item) => item.sk === "#META") ??
        {};
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
    const { signal, current } = this.loads.start();
    for (const list of LISTS) {
      this.lists[list].generation++;
      this.lists[list].controller?.abort();
    }
    const params = periodApiParams(this.period);
    // Concerns and the data time belong to the period no longer shown.
    this.region("freshness").innerHTML = freshnessView(null);
    if (this.region("top").childElementCount) showLoading(this.region("top"));
    showLoading(this.region("body"));
    this.setAttribute("aria-busy", "true");
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await adminApi.reportingSite(this.siteId, params, signal);
    } catch (err) {
      if (superseded(err, current)) return;
      this.removeAttribute("aria-busy");
      this.reply = null;
      // With no period asked or named, the controls step from this month.
      if (!this.period) this.fallback = monthOfToday();
      this.drawHead();
      showLoaded(this.region("top"), "");
      // Other 404s, such as a route the API lacks, are plain failures.
      showLoaded(
        this.region("body"),
        /** @type {any} */ (err)?.message === "site_not_found"
          ? `<p class="empty-state" data-insights-empty="site">${escapeHtml(t("admin.insights.siteNotFound"))}</p>`
          : failedView(failureText(err, t("admin.insights.siteFailed"))),
      );
      // The period controls step from the period asked for instead.
      this.drawPeriod();
      return;
    }
    if (!current()) return;
    this.removeAttribute("aria-busy");
    this.reply = reply;
    for (const list of LISTS) {
      this.lists[list].tile = SITE_LISTS[list].first;
      this.lists[list].concern = "";
    }
    this.drawHead();
    this.region("freshness").innerHTML = freshnessView(reply.meta);
    this.drawPeriod();
    showLoaded(
      this.region("top"),
      siteTopView({ reply, details: this.details, hrefs: this.urls }),
    );
    showLoaded(
      this.region("body"),
      siteBodyView({
        reply,
        tiles: {
          severity: this.lists.severity.tile,
          response: this.lists.response.tile,
        },
      }),
    );
    for (const list of LISTS) void this.loadIssues(list);
  }

  /** @param {SiteList} list @returns {HTMLElement | null} */
  issuesRegion(list) {
    return this.querySelector(`[data-list="${list}"] [data-region="issues"]`);
  }

  /**
   * @param {SiteList} list
   * @param {string} [cursor] the last page's nextCursor
   */
  fetchIssues(list, cursor) {
    const state = this.lists[list];
    // Its own controller, so a newer pick stops the request it replaces.
    state.controller?.abort();
    state.controller = new AbortController();
    return adminApi.reportingIssues(
      {
        ...periodApiParams(this.period),
        siteIds: this.siteId,
        ...listFilter(SITE_LISTS[list].param, state),
        ...(cursor ? { cursor } : {}),
      },
      state.controller.signal,
    );
  }

  /**
   * Lists the selected tiles' Issues; a failure here keeps the counts above.
   * @param {SiteList} list
   */
  async loadIssues(list) {
    const state = this.lists[list];
    const mine = ++state.generation;
    state.issues = null;
    state.failed = "";
    state.more = "";
    this.drawIssues(list);
    const region = this.issuesRegion(list);
    if ((!state.tile && !state.concern) || !region) {
      state.controller?.abort();
      return;
    }
    region.insertAdjacentHTML("beforeend", loadingView());
    try {
      const issues = await this.fetchIssues(list);
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
    this.drawIssues(list);
  }

  /** Adds the next page under the rows already shown. @param {SiteList} list */
  async loadMore(list) {
    const state = this.lists[list];
    const cursor = state.issues?.nextCursor;
    if (!cursor || state.more === "loading") return;
    const mine = state.generation;
    state.more = "loading";
    this.drawIssues(list);
    try {
      const page = await this.fetchIssues(list, cursor);
      if (mine !== state.generation || !state.issues) return;
      state.issues = {
        ...page,
        issues: [...state.issues.issues, ...page.issues],
      };
      state.more = "";
    } catch (err) {
      if (
        mine !== state.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      state.more = failureText(err, t("admin.insights.issuesFailed"));
    }
    this.drawIssues(list);
  }

  /** @param {SiteList} list */
  drawIssues(list) {
    const region = this.issuesRegion(list);
    if (!region) return;
    const state = this.lists[list];
    const button = region.querySelector("[data-load-more]");
    const focused = !!button && button === document.activeElement;
    region.innerHTML = siteIssuesView({
      list,
      issues: state.issues,
      failed: state.failed,
      tile: state.tile,
      concern: state.concern,
      more: state.more,
    });
    // The redraw replaces Load more, so keyboard users keep their place.
    if (focused)
      /** @type {HTMLElement | null} */ (
        region.querySelector("[data-load-more]")
      )?.focus();
  }

  /** @param {SiteList} list */
  drawPressed(list) {
    const on = this.lists[list].tile.split(",");
    for (const button of this.querySelectorAll(
      `[data-list="${list}"] [data-tile]`,
    ))
      button.setAttribute(
        "aria-pressed",
        `${on.includes(button.getAttribute("data-tile") ?? "")}`,
      );
  }

  /** A tile adds or removes its value, or replaces it in a one-at-a-time list. @param {SiteList} list @param {string} tile */
  pickTile(list, tile) {
    if (!this.reply) return;
    const state = this.lists[list];
    const { tiles, single } =
      /** @type {{ tiles: string[], single?: boolean }} */ (SITE_LISTS[list]);
    const picked = toggleTile(tiles, state.tile, tile, single);
    // The same list again would only reload what's on screen.
    if (picked === state.tile && !state.concern) return;
    state.tile = picked;
    state.concern = "";
    this.drawPressed(list);
    void this.loadIssues(list);
  }

  /** @param {string} concern */
  showConcern(concern) {
    if (!this.reply) return;
    const state = this.lists.response;
    state.tile = "";
    state.concern = concern;
    this.drawPressed("response");
    void this.loadIssues("response");
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
    const status = this.querySelector("[data-period-status]");
    // Only a reply's own interval knows how far its data runs.
    const replied = !!interval && interval === this.reply?.meta.interval;
    if (status)
      status.innerHTML = incompletePill(
        interval,
        replied ? (interval.observedTo ?? null) : null,
      );
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
    this.dispatchEvent(new CustomEvent("insights-url", { bubbles: true }));
    this.urls = this.links();
    this.rememberBack();
    this.drawHead();
    this.drawPeriod();
    void this.load();
  }

  /** @param {Event} event */
  clicked = (event) => {
    const target = /** @type {Element} */ (event.target);
    // The app's router reloads the page on a hash change, so a concern's link scrolls here instead.
    const jump = target.closest('a[href^="#insights-"]');
    if (jump && plainClick(/** @type {MouseEvent} */ (event))) {
      event.preventDefault();
      const concern = jump.getAttribute("data-show-concern");
      if (concern) this.showConcern(concern);
      const heading = /** @type {HTMLElement | null} */ (
        this.querySelector(jump.getAttribute("href") ?? "")
      );
      heading?.scrollIntoView({ behavior: "smooth", block: "start" });
      heading?.focus({ preventScroll: true });
      return;
    }
    const button = target.closest("button");
    if (!button || !this.contains(button)) return;
    if (button.id === "insights-retry") return void this.load();
    const list = this.listOf(button);
    if (list && button.id === SITE_LISTS[list].retry)
      return void this.loadIssues(list);
    if (list && button.hasAttribute("data-load-more"))
      return void this.loadMore(list);
    const tile = button.getAttribute("data-tile");
    if (list && tile) return this.pickTile(list, tile);
    if (this.periodBody().contains(button))
      periodClicked(this, button, this.periodBody());
  };
}

if (!customElements.get("insights-site"))
  customElements.define("insights-site", InsightsSite);
