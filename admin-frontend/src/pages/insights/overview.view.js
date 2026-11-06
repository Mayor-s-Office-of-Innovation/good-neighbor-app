// <insights-overview> draws its own parts, so typing in search keeps focus
// while results update.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { debounce } from "../../debounce.js";
import {
  MAX_REPORT_SITES,
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
import { linkLeft } from "./report-job.js";
import {
  drawPeriodControl,
  failedView,
  failureText,
  formatInstant,
  freshnessView,
  intervalFooterView,
  loadingView,
  periodClicked,
  periodLabel,
} from "./insights.templates.js";
import {
  countText,
  filtersView,
  jobView,
  optionsView,
  reportBarText,
  reportBarView,
  reportDialogView,
  resultBarView,
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
    // A reattached element starts with an empty status region.
    this.statusMarkup = "";
    this.periodKind = this.period?.kind ?? "month";
    this.periodError = "";
    // Picks come back with the view they were made on; a new period has other rows.
    const back = this.session.overview;
    const here = this.currentPath();
    const same = back.path === here;
    const returning = same || (!!back.alsoPath && back.alsoPath === here);
    if (same) this.state.selected = [...back.selected];
    // A Site left by another way mustn't pull focus on a later load.
    if (!returning) back.siteId = "";
    this.generation = 0;
    /** @type {import("./insights-session.js").Names} */
    this.names = { managerId: new Map(), providerId: new Map() };
    // <admin-app> gives <admin-insights-page> the signed-in admin's session.
    const admin = /** @type {any} */ (this.closest("admin-insights-page"))
      ?.session;
    // Only a manager linked to the directory can be a Site's manager.
    this.me = admin?.profile?.directoryUserId ?? "";
    // The mock's order: data time, controls, results, then the report hint.
    this.innerHTML = `
      <div data-region="freshness">${freshnessView(null)}</div>
      <div data-region="filters">${filtersView(this.state, NO_OPTIONS, this.me)}</div>
      <div data-region="bar">${resultBarView(this.state)}</div>
      <div data-region="results"></div>
      <div data-region="report">${reportBarView()}</div>
      <footer data-region="footer"></footer>`;
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
    void this.load();
  }

  disconnectedCallback() {
    this.controller?.abort();
    this.search?.cancel();
    this.unsubscribe?.();
    clearTimeout(this.linkTimer);
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
        );
        select.value = /** @type {any} */ (this.state)[name];
      }
      // Mid-load, the table on screen is the spinner, not old rows. A user
      // already in the table keeps their place until they leave it.
      if (!this.reply || this.hasAttribute("aria-busy")) return;
      if (this.region("results").contains(document.activeElement))
        this.drawWhenFocusLeaves();
      else this.drawResults();
    } catch {
      // The table still works; filters then list only what a link chose.
    }
  }

  /** Names arrived while the user was in the table; show them on the way out. */
  drawWhenFocusLeaves() {
    const results = this.region("results");
    this.stopWaitingForFocus();
    const left = (/** @type {FocusEvent} */ event) => {
      // Switching windows blurs the page but leaves focus where it was.
      if (
        results.contains(/** @type {Node | null} */ (event.relatedTarget)) ||
        results.contains(document.activeElement)
      )
        return;
      this.stopWaitingForFocus();
      if (this.reply && !this.hasAttribute("aria-busy")) this.drawResults();
    };
    results.addEventListener("focusout", left);
    this.stopWaitingForFocus = () =>
      results.removeEventListener("focusout", left);
  }

  stopWaitingForFocus = () => {};

  async load() {
    const mine = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    // An old table and interval would claim to match the new filters, so they go now.
    this.region("results").innerHTML = loadingView();
    this.region("footer").innerHTML = "";
    this.setAttribute("aria-busy", "true");
    // Select all and Generate report would act on the old reply's Sites.
    this.drawBar();
    this.drawReport();
    /** @type {Record<string, any>} */
    let reply;
    try {
      reply = await adminApi.reportingOverview(
        overviewApiParams(this.state, this.period),
        this.controller.signal,
      );
    } catch (err) {
      if (
        mine !== this.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      this.removeAttribute("aria-busy");
      this.reply = null;
      // The old data time and notes describe a period no longer shown.
      this.region("freshness").innerHTML = freshnessView(null);
      this.region("results").innerHTML = failedView(
        failureText(err, t("admin.insights.loadFailed")),
      );
      this.drawBar();
      this.drawReport();
      // The period controls step from the period asked for instead.
      this.drawPeriod();
      this.restoreFocus();
      return;
    }
    if (mine !== this.generation) return;
    this.removeAttribute("aria-busy");
    this.reply = reply;
    this.state.selected = keptSelection(this.state.selected, this.listedIds());
    this.keepSelection();
    this.region("freshness").innerHTML = freshnessView(reply.meta);
    this.region("footer").innerHTML = intervalFooterView(reply.meta.interval);
    this.drawPeriod();
    this.drawResults();
    this.drawReport();
    this.returnFocus();
    this.restoreFocus();
  }

  drawResults() {
    this.stopWaitingForFocus();
    if (!this.reply) return;
    this.region("results").innerHTML = resultsView({
      reply: this.reply,
      state: this.state,
      siteHref: (id) => this.siteHref(id),
      names: this.names,
    });
    this.drawBar();
  }

  drawBar() {
    const count = this.querySelector("#insights-count");
    if (count) count.textContent = this.reply ? countText(this.reply) : "";
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
    if (!this.state || !this.session) return;
    const job = this.session.reportJobs.current;
    const { busy, button, hint } = reportBarText({
      selected: this.state.selected.length,
      job,
    });
    const generate = /** @type {HTMLButtonElement | null} */ (
      this.querySelector("#insights-report")
    );
    if (generate) {
      generate.textContent = button;
      // The dialog names the period and data time, which need a reply.
      generate.disabled =
        !this.state.selected.length || busy || !this.reply || this.loading();
    }
    const help = this.querySelector("#insights-report-hint");
    if (help) help.textContent = hint;
    const status = /** @type {HTMLElement | null} */ (
      this.querySelector("#insights-report-status")
    );
    const left = linkLeft(job, Date.now());
    const stale = job?.phase === "succeeded" && !left;
    const markup = job ? jobView(job, stale) : "";
    // Same words, same nodes, so a screen reader isn't told twice.
    if (status && this.statusMarkup !== markup) {
      const had = status.contains(document.activeElement);
      this.statusMarkup = markup;
      status.innerHTML = markup;
      // Cancel or the fresh-link button went with the redraw.
      if (had) status.focus();
    }
    clearTimeout(this.linkTimer);
    // Swap Download for a fresh-link button when the signed link runs out.
    if (left) this.linkTimer = setTimeout(() => this.drawReport(), left);
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
    const mine = /** @type {any} */ (this.querySelector("#insights-mine"));
    if (mine) mine.checked = this.state.managerId === this.me;
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
    // The Manager filter set to the user, so a shared link shows the same Sites.
    if (target.id === "insights-mine")
      return this.refine({ managerId: target.checked ? this.me : "" });
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

  /** Keeps the user's own picks first, in the order they made them. @param {boolean} on */
  selectAll(on) {
    if (this.loading()) return;
    const ids = this.listedIds();
    const mine = this.state.selected;
    const picked = new Set(mine);
    this.state.selected = on
      ? [...mine, ...ids.filter((id) => !picked.has(id))].slice(
          0,
          MAX_REPORT_SITES,
        )
      : [];
    this.selectionChanged();
  }

  /** @param {string} siteId @param {boolean} on */
  select(siteId, on) {
    const rest = this.state.selected.filter((id) => id !== siteId);
    this.state.selected = on ? [...rest, siteId] : rest;
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
    if (!button) return this.rowClicked(target);
    if (!this.contains(button)) return;
    // A control in the table goes with the redraw; focus then goes to the count.
    if (this.region("results").contains(button)) this.refocus = true;
    const show = button.getAttribute("data-show");
    if (show && SHOW.includes(show)) {
      // Pressing the shown view again mustn't drop the picks.
      if (show !== this.state.show) this.refine({ show });
      return;
    }
    if (this.region("period").contains(button)) {
      periodClicked(this, button, this.region("period"));
      return;
    }
    if (button.id === "insights-retry") return void this.load();
    if (button.id === "insights-clear-filters")
      return this.refine(
        Object.fromEntries(["q", ...OVERVIEW_FILTERS].map((key) => [key, ""])),
      );
    if (button.id === "insights-report") return this.openReportDialog();
    if (button.id === "insights-report-refresh")
      return void this.session.reportJobs.refresh();
    const site = button.getAttribute("data-site-link");
    if (site)
      this.session.overview = {
        path: this.currentPath(),
        siteId: site,
        selected: [...this.state.selected],
        alsoPath: "",
      };
  };

  /** A click anywhere on a row opens its Site; the name stays the real link. @param {Element} target */
  rowClicked(target) {
    if (target.closest("wa-checkbox, [popover]")) return;
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
    const { siteId, path, alsoPath } = this.session.overview;
    const here = this.currentPath();
    if (!siteId || (path !== here && alsoPath !== here)) return;
    this.session.overview.siteId = "";
    /** @type {HTMLElement | null} */ (
      this.querySelector(`[data-site-link="${CSS.escape(siteId)}"]`)
    )?.focus();
  }

  openReportDialog() {
    if (!this.reply || !this.state.selected.length || this.loading()) return;
    this.querySelector("#insights-report-dialog")?.remove();
    // Confirm sends what the dialog counted, even if a load lands meanwhile.
    this.reportAsk = {
      siteIds: [...this.state.selected],
      period: this.period ?? periodOf(this.reply.meta.interval),
    };
    this.insertAdjacentHTML(
      "beforeend",
      reportDialogView({
        count: this.reportAsk.siteIds.length,
        period: periodLabel(this.reply.meta.interval),
        time: formatInstant(this.reply.meta.asOf),
      }),
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
    if (!confirmed || !ask) {
      /** @type {HTMLElement | null} */ (
        this.querySelector("#insights-report")
      )?.focus();
      return;
    }
    void this.session.reportJobs.start(
      ask.siteIds,
      periodApiParams(ask.period),
    );
    // The button is disabled while the report runs; its progress is here.
    /** @type {HTMLElement | null} */ (
      this.querySelector("#insights-report-status")
    )?.focus();
  };
}

if (!customElements.get("insights-overview"))
  customElements.define("insights-overview", InsightsOverview);
