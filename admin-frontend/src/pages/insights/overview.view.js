// <insights-overview> draws its own parts, so typing in search keeps focus
// while results update.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { debounce } from "../../debounce.js";
import {
  OVERVIEW_FILTERS,
  SHOW,
  keptSelection,
  overviewApiParams,
  overviewSearch,
  periodApiParams,
  periodOf,
  readOverview,
  readPeriod,
} from "./insights-query.js";
import { carriedQuery } from "./insights-routes.js";
import { sessionOf } from "./insights-session.js";
import { JobAction } from "./job-action.js";
import { LatestLoad, superseded } from "./latest-load.js";
import {
  drawPeriodControl,
  failedView,
  failureText,
  freshnessView,
  drawInterval,
  monthOfToday,
  showLoaded,
  showLoading,
  periodClicked,
} from "./insights.templates.js";
import {
  arrival,
  pickAll,
  pickOne,
  plainClick,
  siteToFocus,
} from "./overview-rules.js";
import {
  countText,
  filtersView,
  optionsView,
  overviewBarView,
  reportButtonText,
  reportDialogView,
  resultsView,
  selectAllState,
} from "./overview.templates.js";

/** @typedef {import("./insights-query.js").Period} Period */

const NO_OPTIONS = { managerId: [], providerId: [], department: [] };

class InsightsOverview extends HTMLElement {
  connectedCallback() {
    this.session = sessionOf(this);
    this.state = readOverview(location.search);
    /** @type {Period | null} */
    this.period = readPeriod(location.search);
    /** @type {Record<string, any> | null} */
    this.reply = null;
    /** @type {{ siteIds: string[], period: Period } | null} */
    this.reportAsk = null;
    /** @type {number | null} every Site, for "22 Sites (out of 500)" */
    this.allSites = null;
    /** @type {Period | null} */
    this.fallback = null;
    this.periodKind = this.period?.kind ?? "month";
    this.periodError = "";
    const back = this.session.overview;
    const { selected, returning } = arrival(back, this.currentPath());
    this.state.selected = selected;
    // A Site left by another way mustn't pull focus on a later load.
    if (!returning) back.siteId = "";
    this.loads = new LatestLoad();
    /** @type {import("./insights-session.js").Names} */
    this.names = { managerId: new Map(), providerId: new Map() };
    // <admin-app> gives <admin-insights-page> the signed-in admin's session.
    const admin = /** @type {any} */ (this.closest("admin-insights-page"))
      ?.session;
    // Only a manager linked to the directory can be a Site's manager.
    this.me = admin?.profile?.directoryUserId ?? "";
    this.innerHTML = `
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="filters">${filtersView(this.state, NO_OPTIONS, this.me)}</div>
      <div data-region="bar">${overviewBarView(this.state)}</div>
      <div data-region="results"></div>
`;
    this.report = new JobAction(this, {
      id: "insights-report",
      jobs: this.session.reportJobs,
      words: {
        busy: "admin.insights.report.generating",
        done: "admin.insights.report.done",
        errors: "admin.insights.report.error",
        refreshFailed: "admin.insights.report.refreshFailed",
      },
    });
    this.search = debounce(() => this.searchChanged(), 300);
    this.addEventListener("click", this.clicked);
    this.addEventListener("input", this.typed);
    this.addEventListener("change", this.changed);
    this.addEventListener("close", this.dialogClosed, true);
    this.unsubscribe = this.session.reportJobs.subscribe(() =>
      this.drawReport(),
    );
    this.drawPeriod();
    this.drawReport();
    void this.loadOptions();
    void this.loadSiteTotal();
    void this.load();
  }

  disconnectedCallback() {
    this.loads?.abort();
    this.search?.cancel();
    this.unsubscribe?.();
    this.report?.destroy();
    this.removeEventListener("click", this.clicked);
    this.removeEventListener("input", this.typed);
    this.removeEventListener("change", this.changed);
    this.removeEventListener("close", this.dialogClosed, true);
  }

  /** @param {string} name @returns {HTMLElement} */
  region(name) {
    return /** @type {HTMLElement} */ (
      this.querySelector(`[data-region="${name}"]`)
    );
  }

  async loadOptions() {
    try {
      const { options, names } = await this.session.filterOptions();
      if (!this.isConnected) return;
      this.names = names;
      for (const name of ["managerId", "providerId", "department"]) {
        const select = /** @type {any} */ (
          this.querySelector(`wa-select[data-filter="${name}"]`)
        );
        if (!select) continue;
        select.innerHTML = optionsView(
          select.dataset.allLabel,
          options[/** @type {keyof typeof options} */ (name)],
          /** @type {any} */ (this.state)[name],
          name === "managerId" ? this.me : "",
        );
        select.value = /** @type {any} */ (this.state)[name];
      }
      // Filled in place, so a user working in the table keeps their place.
      for (const line of /** @type {NodeListOf<HTMLElement>} */ (
        this.querySelectorAll("[data-manager]")
      )) {
        const id = line.dataset.manager ?? "";
        line.textContent = names.managerId.get(id) ?? id;
      }
    } catch {
      // The table still works; filters then list only what a link chose.
    }
  }

  async loadSiteTotal() {
    try {
      this.allSites = (await this.session.siteOptions()).length;
    } catch {
      // The count then reads "22 Sites", without the total.
      return;
    }
    if (this.isConnected) this.drawBar();
  }

  async load() {
    const { signal, current } = this.loads.start();
    // An old table and interval would claim to match the new filters, so they go now.
    showLoading(this.region("results"));
    drawInterval(this, null);
    this.setAttribute("aria-busy", "true");
    // Select all and Generate report would act on the old reply's Sites.
    this.drawBar();
    this.drawReport();
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await adminApi.reportingOverview(
        overviewApiParams(this.state, this.period),
        signal,
      );
    } catch (err) {
      if (superseded(err, current)) return;
      this.removeAttribute("aria-busy");
      this.reply = null;
      // Without a period from the server, the controls step from this month.
      if (!this.period) this.fallback = monthOfToday();
      // The old data time and notes describe a period no longer shown.
      this.region("freshness").innerHTML = freshnessView(null);
      showLoaded(
        this.region("results"),
        failedView(failureText(err, t("admin.insights.loadFailed"))),
      );
      this.drawBar();
      this.drawReport();
      // The period controls step from the period asked for instead.
      this.drawPeriod();
      this.restoreFocus();
      return;
    }
    if (!current()) return;
    this.removeAttribute("aria-busy");
    this.reply = reply;
    this.state.selected = keptSelection(this.state.selected, this.listedIds());
    this.keepSelection();
    this.region("freshness").innerHTML = freshnessView(reply.meta);
    drawInterval(this, reply.meta.interval);
    this.drawPeriod();
    this.drawResults();
    this.drawReport();
    this.returnFocus();
    this.restoreFocus();
  }

  drawResults() {
    if (!this.reply) return;
    showLoaded(
      this.region("results"),
      resultsView({
        reply: this.reply,
        state: this.state,
        siteHref: (id) => this.siteHref(id),
        names: this.names,
      }),
    );
    this.drawBar();
  }

  drawBar() {
    const count = this.querySelector("#insights-count");
    // The old reply's count would be announced as if it matched the new filters.
    if (count)
      count.textContent =
        this.reply && !this.loading()
          ? countText(this.reply, this.state, this.allSites)
          : "";
    const all = /** @type {any} */ (this.querySelector("#insights-select-all"));
    if (!all) return;
    const ids = this.listedIds();
    const { checked, indeterminate } = selectAllState(ids, this.state.selected);
    all.disabled = !ids.length || this.loading();
    all.checked = checked;
    all.indeterminate = indeterminate;
  }

  /** Until the new reply draws, the one held is for the old query. */
  loading() {
    return this.hasAttribute("aria-busy");
  }

  /** @returns {string[]} */
  listedIds() {
    return (this.reply?.sites ?? []).map((/** @type {any} */ s) => s.siteId);
  }

  drawPeriod() {
    drawPeriodControl(this, this.region("period"));
  }

  drawReport() {
    if (!this.state || !this.report) return;
    const { label, why } = reportButtonText(this.state.selected.length);
    // The dialog sends the period on screen, which needs a reply.
    this.report.draw({
      label,
      why,
      off: !this.state.selected.length || !this.reply || this.loading(),
    });
  }

  /** Site insights links back to this exact view. @param {string} siteId */
  siteHref(siteId) {
    const query = new URLSearchParams(carriedQuery(location.search));
    query.set("return", this.currentPath());
    return `/insights/sites/${encodeURIComponent(siteId)}?${query}`;
  }

  writeUrl() {
    const path = `${location.pathname}${overviewSearch(this.state, this.period)}`;
    history.replaceState(history.state, "", path);
    this.keepSelection();
    // The dashboard keeps its last-drawn path for its guards and tab memory.
    this.dispatchEvent(new CustomEvent("insights-url", { bubbles: true }));
  }

  /** The picks stay off the URL, so the way back and a reattach find them here. */
  keepSelection() {
    this.session.overview.path = this.currentPath();
    this.session.overview.selected = [...this.state.selected];
  }

  /**
   * A new population, so the selection resets.
   * @param {Partial<import("./insights-query.js").OverviewState>} change
   */
  refine(change) {
    Object.assign(this.state, change, { selected: [] });
    this.reload();
  }

  /** Every Site is listed, so a new order keeps the picks. @param {string} sort */
  resort(sort) {
    this.state.sort = sort;
    this.reload();
  }

  reload() {
    this.writeUrl();
    this.syncFilters();
    this.drawReport();
    void this.load();
  }

  /** Clear filters and Show change state from outside the controls. */
  syncFilters() {
    for (const button of this.querySelectorAll("[data-show]"))
      if (this.region("filters").contains(button))
        button.setAttribute(
          "aria-pressed",
          `${button.getAttribute("data-show") === this.state.show}`,
        );
    const search = /** @type {any} */ (this.querySelector("#insights-search"));
    // The box the user is typing in already shows what they typed.
    if (search && document.activeElement !== search)
      search.value = this.state.q;
    for (const name of OVERVIEW_FILTERS) {
      const select = /** @type {any} */ (
        this.querySelector(`wa-select[data-filter="${name}"]`)
      );
      if (select) select.value = this.state[name];
    }
  }

  searchChanged() {
    const input = /** @type {any} */ (this.querySelector("#insights-search"));
    const q = String(input?.value ?? "").trim();
    if (q !== this.state.q) this.refine({ q });
  }

  /** @param {Event} event */
  typed = (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.id === "insights-search") this.search.schedule();
  };

  /** @param {Event} event */
  changed = (event) => {
    const target = /** @type {any} */ (event.target);
    // wa-input's clear button fires change without input.
    if (target.id === "insights-search") return this.search.schedule();
    const filter = target.dataset?.filter;
    if (filter) {
      const value = String(target.value ?? "");
      if (value === /** @type {any} */ (this.state)[filter]) return;
      if (filter === "sort") this.resort(value);
      else this.refine({ [filter]: value });
      return;
    }
    if (target.id === "insights-select-all")
      return this.selectAll(target.checked);
    const siteId = target.dataset?.selectSite;
    if (siteId) this.select(siteId, target.checked);
  };

  /** @param {boolean} on */
  selectAll(on) {
    if (this.loading()) return;
    this.state.selected = pickAll(this.state.selected, this.listedIds(), on);
    this.selectionChanged();
  }

  /** @param {string} siteId @param {boolean} on */
  select(siteId, on) {
    this.state.selected = pickOne(this.state.selected, siteId, on);
    this.selectionChanged();
  }

  selectionChanged() {
    this.state.selected = keptSelection(this.state.selected, this.listedIds());
    this.keepSelection();
    const picked = new Set(this.state.selected);
    // In place, so the box the user is on keeps focus.
    for (const box of /** @type {NodeListOf<any>} */ (
      this.querySelectorAll("[data-select-site]")
    ))
      box.checked = picked.has(box.dataset.selectSite ?? "");
    this.drawBar();
    this.drawReport();
  }

  /** @param {Event} event */
  clicked = (event) => {
    const target = /** @type {Element} */ (event.target);
    const button = target.closest("button, a");
    if (!button) return this.rowClicked(/** @type {MouseEvent} */ (event));
    if (!this.contains(button)) return;
    // A button in the table goes with the reload's redraw; focus then goes to the count.
    const inTable = this.region("results").contains(button);
    const show = button.getAttribute("data-show");
    if (show && SHOW.includes(show)) {
      // Pressing the shown view again mustn't drop the picks.
      if (show === this.state.show) return;
      this.refocus = inTable;
      return this.refine({ show });
    }
    if (this.region("period").contains(button)) {
      periodClicked(this, button, this.region("period"));
      return;
    }
    if (button.id === "insights-retry") {
      this.refocus = inTable;
      return void this.load();
    }
    if (button.id === "insights-clear-filters") {
      this.refocus = inTable;
      return this.refine(
        Object.fromEntries(["q", ...OVERVIEW_FILTERS].map((key) => [key, ""])),
      );
    }
    if (button.id === "insights-report") return this.openReportDialog();
    const site = button.getAttribute("data-site-link");
    // A new tab or window leaves this view open, so it has nothing to return to.
    if (site && plainClick(/** @type {MouseEvent} */ (event)))
      this.session.overview = {
        path: this.currentPath(),
        siteId: site,
        selected: [...this.state.selected],
        alsoPath: "",
      };
  };

  /** A click anywhere on a row opens its Site; the name stays the real link. @param {MouseEvent} event */
  rowClicked(event) {
    const target = /** @type {Element} */ (event.target);
    if (target.closest("wa-checkbox, [popover]")) return;
    // The forwarded click drops modifier keys, and a drag selects text, not the row.
    if (!plainClick(event) || String(document.getSelection?.() ?? "")) return;
    /** @type {HTMLElement | null | undefined} */ (
      target.closest("[data-site-row]")?.querySelector("[data-site-link]")
    )?.click();
  }

  currentPath() {
    return `${location.pathname}${location.search}`;
  }

  /** @param {Period} period */
  periodPicked(period) {
    this.period = period;
    this.periodKind = period.kind;
    this.periodError = "";
    this.refine({});
    this.drawPeriod();
  }

  /** The control the user pressed was redrawn; the count is next to it. */
  restoreFocus() {
    if (!this.refocus) return;
    this.refocus = false;
    if (!this.contains(document.activeElement))
      /** @type {HTMLElement | null} */ (
        this.querySelector("#insights-count")
      )?.focus();
  }

  returnFocus() {
    const siteId = siteToFocus(this.session.overview, this.currentPath());
    if (!siteId) return;
    this.session.overview.siteId = "";
    /** @type {HTMLElement | null} */ (
      this.querySelector(`[data-site-link="${CSS.escape(siteId)}"]`)
    )?.focus();
  }

  openReportDialog() {
    if (!this.reply || this.report.off()) return;
    this.querySelector("#insights-report-dialog")?.remove();
    // Confirm sends what the dialog counted, even if a load lands meanwhile.
    this.reportAsk = {
      siteIds: [...this.state.selected],
      period: this.period ?? periodOf(this.reply.meta.interval),
    };
    this.insertAdjacentHTML(
      "beforeend",
      reportDialogView({ count: this.reportAsk.siteIds.length }),
    );
    /** @type {HTMLDialogElement} */ (
      this.querySelector("#insights-report-dialog")
    ).showModal();
  }

  /** @param {Event} event */
  dialogClosed = (event) => {
    const dialog = /** @type {HTMLDialogElement} */ (event.target);
    if (dialog.id !== "insights-report-dialog") return;
    const confirmed = dialog.returnValue === "confirm";
    const ask = this.reportAsk;
    this.reportAsk = null;
    dialog.remove();
    if (confirmed && ask)
      void this.session.reportJobs.start(
        ask.siteIds,
        periodApiParams(ask.period),
      );
    // The button shows the report's progress, so focus stays on it.
    /** @type {HTMLElement | null} */ (
      this.querySelector("#insights-report")
    )?.focus();
  };
}

if (!customElements.get("insights-overview"))
  customElements.define("insights-overview", InsightsOverview);
