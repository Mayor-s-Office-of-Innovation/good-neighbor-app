// <insights-raw-list>: the Issues or Checks behind the numbers, filtered, grouped and exportable.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { adminApi } from "../../services/admin-api.js";
import { periodOf, readPeriod } from "./insights-query.js";
import { carriedQuery, returnPathTo } from "./insights-routes.js";
import { emptyRaw, sessionOf } from "./insights-session.js";
import {
  drawPeriodControl,
  failedView,
  failureText,
  freshnessView,
  drawInterval,
  showLoaded,
  showLoading,
  periodClicked,
} from "./insights.templates.js";
import { optionsView } from "./overview.templates.js";
import { recordHref } from "./record-links.js";
import { RecordPanel, hopOf, plainClick } from "./record-panel.js";
import { JobAction } from "./job-action.js";
import {
  MAX_EXPORT_ROWS,
  exportBody,
  rawApiParams,
  rawSearch,
  readRaw,
} from "./raw-query.js";
import {
  categoryOptions,
  checksView,
  countText,
  exportDialogView,
  exportWhyOff,
  filtersToggleText,
  issuesView,
  rawBarView,
  rawFiltersView,
  rawHeadView,
  rawTabsView,
  siteOptions,
} from "./raw.templates.js";

/** @typedef {import("./insights-query.js").Period} Period */
/** @typedef {import("./raw-query.js").RawKind} RawKind */
/** @typedef {Record<string, any>} Row */

// Asking again with the same cursor fails the same way.
const RESTART_PAGING = new Set([
  "snapshot_changed",
  "invalid_cursor",
  "cursor_query_mismatch",
]);

class InsightsRawList extends HTMLElement {
  connectedCallback() {
    this.session = sessionOf(this);
    /** @type {RawKind} */
    this.kind = this.dataset.kind === "checks" ? "checks" : "issues";
    this.state = readRaw(this.kind, location.search);
    /** @type {Period | null} */
    this.period = readPeriod(location.search);
    this.periodKind = this.period?.kind ?? "month";
    this.periodError = "";
    /** @type {Row | null} the last reply that loaded, for its count, period and data time */
    this.reply = null;
    /** @type {Row[]} every row loaded so far, Load more pages included */
    this.rows = [];
    this.nextCursor = "";
    this.more = "";
    this.stale = "";
    this.notice = "";
    /** @type {{ body: Record<string, unknown>, count: number } | null} */
    this.exportAsk = null;
    this.generation = 0;
    this.panel = new RecordPanel(this, {
      fullLabel: t("admin.insights.panel.open"),
      back: () => this.backPath(),
      // Marks this history entry, so only browser Back to it restores the rows.
      left: () =>
        history.replaceState({ ...history.state, insightsReturn: true }, ""),
    });
    this.innerHTML = `
      ${rawHeadView()}
      <div data-region="freshness">${freshnessView(null)}</div>
      ${rawTabsView(this.kind, carriedQuery(location.search))}
      <div data-region="filters">${rawFiltersView(this.kind, this.state, {})}</div>
      <div data-region="bar">${rawBarView(this.kind, this.state)}</div>
      <div data-region="results"></div>
`;
    this.export = new JobAction(this, {
      id: "insights-export",
      jobs: this.session.exportJobs[this.kind],
      words: {
        busy: "admin.insights.export.exporting",
        done: "admin.insights.export.done",
        errors: "admin.insights.export.error",
        refreshFailed: "admin.insights.export.refreshFailed",
      },
    });
    this.addEventListener("click", this.clicked);
    this.addEventListener("change", this.changed);
    this.addEventListener("close", this.dialogClosed, true);
    this.unsubscribe = this.session.exportJobs[this.kind].subscribe(() =>
      this.drawExport(),
    );
    this.drawPeriod();
    this.drawExport();
    void this.loadOptions();
    // Back from a record shows the rows left, every loaded page included.
    // Opened any other way, the list loads fresh, so its data is current.
    const memory = this.session.raw[this.kind];
    const returning =
      history.state?.insightsReturn ||
      this.session.returning === this.currentPath();
    this.session.returning = "";
    if (returning && memory.path === this.currentPath() && memory.reply) {
      this.reply = memory.reply;
      this.rows = memory.rows;
      this.nextCursor = memory.nextCursor;
      this.more = this.nextCursor ? "ready" : "";
      this.drawLoaded();
      // A task later, so it comes after the dashboard focuses the page title on arrival.
      this.focusTimer = setTimeout(() => this.returnFocus(), 0);
    } else if (
      /^\/insights\/raw\/(issues|checks)\/?$/.test(location.pathname)
    ) {
      // A view left by another way mustn't pull focus later. The dashboard
      // can draw the list once more as it leaves for a record; that draw
      // mustn't wipe what the record's way back needs.
      this.session.raw[this.kind] = emptyRaw();
      void this.load();
    }
  }

  disconnectedCallback() {
    this.moreObserver?.disconnect();
    this.controller?.abort();
    this.panel?.destroy();
    this.unsubscribe?.();
    this.export?.destroy();
    clearTimeout(this.focusTimer);
    this.removeEventListener("click", this.clicked);
    this.removeEventListener("change", this.changed);
    this.removeEventListener("close", this.dialogClosed, true);
  }

  /** @param {string} name @returns {HTMLElement} */
  region(name) {
    return /** @type {HTMLElement} */ (
      this.querySelector(`[data-region="${name}"]`)
    );
  }

  currentPath() {
    return `${location.pathname}${location.search}`;
  }

  backPath() {
    return returnPathTo(location.pathname, location.search);
  }

  /** @param {string} name @param {{ value: string, label: string }[]} options @param {string} value */
  fillSelect(name, options, value) {
    const select = /** @type {any} */ (
      this.querySelector(`wa-select[data-filter="${name}"]`)
    );
    if (!select) return;
    select.innerHTML = optionsView(select.dataset.allLabel, options, value);
    select.value = value;
  }

  async loadOptions() {
    // Each list fails alone; a select left empty still shows a linked value.
    const [filters, programs, sites, categories] = await Promise.allSettled([
      this.session.filterOptions(),
      this.session.programOptions(),
      this.session.siteOptions(),
      this.session.categories(),
    ]);
    if (!this.isConnected) return;
    if (filters.status === "fulfilled")
      for (const name of /** @type {const} */ ([
        "providerId",
        "department",
        "managerId",
      ]))
        this.fillSelect(
          name,
          filters.value.options[name],
          this.state.filters[name],
        );
    if (programs.status === "fulfilled")
      this.fillSelect(
        "programId",
        programs.value,
        this.state.filters.programId,
      );
    if (sites.status === "fulfilled")
      this.fillSelect(
        "siteIds",
        siteOptions(this.state, sites.value),
        this.state.siteIds.join(","),
      );
    if (categories.status === "fulfilled")
      this.fillSelect(
        "category",
        categoryOptions(categories.value),
        this.state.filters.category,
      );
  }

  /** @param {string} cursor */
  fetchPage(cursor) {
    const params = rawApiParams(this.kind, this.state, this.period, cursor);
    const signal = /** @type {AbortController} */ (this.controller).signal;
    return this.kind === "issues"
      ? adminApi.reportingIssues(params, signal)
      : adminApi.reportingChecks(params, signal);
  }

  async load() {
    const mine = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    this.stale = "";
    // A page of the old filters can't follow the new ones, even if this load fails.
    this.more = "";
    // The rows and interval on screen answer the old filters, so they go until the new ones load.
    showLoading(this.region("results"));
    drawInterval(this, null);
    this.setAttribute("aria-busy", "true");
    this.drawCount();
    this.drawExport();
    /** @type {Row} */
    let reply;
    try {
      reply = await this.fetchPage("");
    } catch (err) {
      if (
        mine !== this.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      this.removeAttribute("aria-busy");
      const message = failureText(
        err,
        t(`admin.insights.raw.loadFailed.${this.kind}`),
      );
      this.drawPeriod();
      if (this.rows.length && this.reply) {
        // The last rows stay, under a banner that says they're out of date.
        this.stale = t("admin.insights.raw.stale");
        drawInterval(this, this.reply.meta.interval);
        this.drawResults();
        this.drawExport();
      } else {
        this.region("freshness").innerHTML = freshnessView(null);
        drawInterval(this, null);
        showLoaded(this.region("results"), failedView(message));
        this.drawCount();
        this.drawExport();
      }
      this.restoreFocus();
      return;
    }
    if (mine !== this.generation) return;
    this.removeAttribute("aria-busy");
    this.reply = reply;
    this.rows = this.rowsOf(reply);
    this.nextCursor = reply.nextCursor ?? "";
    this.more = this.nextCursor ? "ready" : "";
    this.remember();
    this.drawLoaded();
    this.notice = "";
    this.restoreFocus();
  }

  /** @param {Row} reply @returns {Row[]} */
  rowsOf(reply) {
    return this.kind === "issues" ? reply.issues : reply.checks;
  }

  /** @param {{ byUser?: boolean }} [how] a scroll load leaves focus where the reader is */
  async loadMore({ byUser = true } = {}) {
    if (!this.nextCursor || this.more === "loading") return;
    const mine = this.generation;
    this.more = "loading";
    this.drawResults();
    const first = this.rows.length;
    /** @type {Row} */
    let reply;
    try {
      reply = await this.fetchPage(this.nextCursor);
    } catch (err) {
      if (
        mine !== this.generation ||
        /** @type {any} */ (err)?.name === "AbortError"
      )
        return;
      const code = /** @type {any} */ (err)?.message;
      if (RESTART_PAGING.has(code)) {
        // New data leaves no place to resume, so the list starts again.
        this.notice = t("admin.insights.raw.restarted");
        this.refocus = byUser;
        return void this.load();
      }
      this.more = failureText(err, t("admin.insights.raw.moreFailed"));
      this.drawResults();
      if (byUser)
        /** @type {HTMLElement | null} */ (
          this.querySelector("#insights-load-more")
        )?.focus();
      return;
    }
    if (mine !== this.generation) return;
    this.rows = [...this.rows, ...this.rowsOf(reply)];
    this.nextCursor = reply.nextCursor ?? "";
    this.more = this.nextCursor ? "ready" : "";
    this.remember();
    this.drawResults();
    if (!byUser) return;
    // The button may be gone, so focus goes on to the first new row.
    /** @type {HTMLElement | null | undefined} */ (
      this.querySelectorAll("[data-record-link]")[first]
    )?.focus();
  }

  remember() {
    this.session.raw[this.kind] = {
      path: this.currentPath(),
      reply: this.reply,
      rows: this.rows,
      nextCursor: this.nextCursor,
      focus: this.session.raw[this.kind].focus,
    };
  }

  drawLoaded() {
    if (!this.reply) return;
    this.region("freshness").innerHTML = freshnessView(this.reply.meta);
    drawInterval(this, this.reply.meta.interval);
    this.drawPeriod();
    this.drawResults();
    this.drawExport();
  }

  drawResults() {
    if (!this.reply) return;
    const view = {
      rows: this.rows,
      reply: this.reply,
      state: this.state,
      href: (/** @type {Row} */ row) => this.recordHref(row),
      more: this.more,
      notice: this.notice,
      stale: this.stale,
    };
    showLoaded(
      this.region("results"),
      this.kind === "issues" ? issuesView(view) : checksView(view),
    );
    this.drawCount();
    this.watchMore();
  }

  // Scrolling near the end loads the next page; the button stays for keyboard and screen-reader users.
  watchMore() {
    this.moreObserver?.disconnect();
    const row = this.querySelector(".insights__more");
    if (
      !row ||
      this.more !== "ready" ||
      typeof IntersectionObserver !== "function"
    )
      return;
    this.moreObserver ??= new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && this.more === "ready")
          void this.loadMore({ byUser: false });
      },
      // Starts a screen early, so the reader rarely waits at the bottom.
      { rootMargin: "0px 0px 600px 0px" },
    );
    this.moreObserver.observe(row);
  }

  drawCount() {
    const count = this.querySelector("#insights-count");
    if (count)
      count.textContent =
        this.reply && !this.loading() ? countText(this.kind, this.reply) : "";
  }

  loading() {
    return this.hasAttribute("aria-busy");
  }

  /** @param {Row} row */
  recordHref(row) {
    return recordHref(
      {
        kind: this.kind === "issues" ? "issue" : "check",
        siteId: row.siteId,
        id: this.kind === "issues" ? row.issueId : row.checkId,
      },
      { search: location.search, back: this.backPath() },
    );
  }

  drawPeriod() {
    drawPeriodControl(this, this.region("period"));
  }

  drawExport() {
    if (!this.export) return;
    // A stale list's count is for the old filters, so it can't be exported.
    const total =
      this.reply && !this.loading() && !this.stale ? this.reply.total : null;
    this.export.draw({
      label: t("admin.insights.export.button"),
      why: exportWhyOff(total),
      off: !total || total > MAX_EXPORT_ROWS,
    });
  }

  writeUrl() {
    const path = `${location.pathname}${rawSearch(this.kind, this.state, this.period)}`;
    history.replaceState(history.state, "", path);
    this.dispatchEvent(new CustomEvent("insights-url", { bubbles: true }));
  }

  /** A new population: the list starts over. @param {(state: import("./raw-query.js").RawState) => void} change */
  refine(change) {
    change(this.state);
    this.writeUrl();
    this.syncFilters();
    void this.load();
  }

  /** Phones fold the filters away; the button says how many are on. */
  toggleFilters() {
    const toggle = /** @type {HTMLElement} */ (
      this.querySelector("#insights-filters-toggle")
    );
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    this.querySelector("#insights-controls")?.toggleAttribute(
      "data-open",
      open,
    );
  }

  /** Clear filters changes state from outside the controls. */
  syncFilters() {
    const toggle = this.querySelector("#insights-filters-toggle");
    if (toggle) toggle.textContent = filtersToggleText(this.kind, this.state);
    for (const [name, value] of [
      ...Object.entries(this.state.filters),
      ["siteIds", this.state.siteIds.join(",")],
    ]) {
      const select = /** @type {any} */ (
        this.querySelector(`wa-select[data-filter="${name}"]`)
      );
      if (select) select.value = value;
    }
  }

  /** @param {Event} event */
  changed = (event) => {
    const target = /** @type {any} */ (event.target);
    const value = String(target.value ?? "");
    if (target.id === "insights-group") {
      if (value !== this.state.group) this.refine((s) => (s.group = value));
      return;
    }
    const filter = target.dataset?.filter;
    if (filter === "siteIds") {
      if (value !== this.state.siteIds.join(","))
        this.refine((s) => (s.siteIds = value ? value.split(",") : []));
      return;
    }
    if (filter && value !== this.state.filters[filter])
      this.refine((s) => (s.filters[filter] = value));
  };

  /** @param {MouseEvent} event */
  clicked = (event) => {
    const target = /** @type {Element} */ (event.target);
    if (this.panel.dialog?.contains(target)) return;
    const control = target.closest("button, a");
    if (!control) return this.rowClicked(target, event);
    if (!this.contains(control)) return;
    if (control.matches("[data-record-link]") && plainClick(event)) {
      event.preventDefault();
      return this.openPanel(/** @type {HTMLElement} */ (control));
    }
    // A control in the list goes with the redraw; focus then goes to the count.
    if (this.region("results").contains(control)) this.refocus = true;
    if (this.region("period").contains(control)) {
      periodClicked(this, control, this.region("period"));
      return;
    }
    if (control.id === "insights-load-more") {
      this.refocus = false;
      return void this.loadMore();
    }
    if (control.id === "insights-retry") return void this.load();
    if (control.id === "insights-filters-toggle") return this.toggleFilters();
    if (control.id === "insights-clear-filters")
      return this.refine((s) => {
        s.siteIds = [];
        for (const key of Object.keys(s.filters)) s.filters[key] = "";
      });
    if (control.id === "insights-export") return this.openExportDialog();
  };

  /** A click anywhere on a row opens it, so the small link isn't the only target. @param {Element} target @param {MouseEvent} event */
  rowClicked(target, event) {
    if (target.closest("[popover]") || !plainClick(event)) return;
    const link = /** @type {HTMLElement | null | undefined} */ (
      target
        .closest("[data-issue-row], [data-check-row]")
        ?.querySelector("[data-record-link]")
    );
    if (link && this.region("results").contains(link)) this.openPanel(link);
  }

  /** @param {HTMLElement} link */
  openPanel(link) {
    const hop = hopOf(link);
    if (!hop) return;
    // Remembered, so a trip to the full record comes back to this row.
    this.session.raw[this.kind].focus =
      link.getAttribute("data-record-link") ?? "";
    this.panel.open(hop, link);
  }

  /** @param {Period} period */
  periodPicked(period) {
    this.period = period;
    this.periodKind = period.kind;
    this.periodError = "";
    this.refine(() => {});
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

  /** A user back from a record carries on from its row, not the top. */
  returnFocus() {
    const memory = this.session.raw[this.kind];
    if (!memory.focus) return;
    const key = memory.focus;
    memory.focus = "";
    /** @type {HTMLElement | null} */ (
      this.querySelector(`[data-record-link="${CSS.escape(key)}"]`)
    )?.focus();
  }

  openExportDialog() {
    const reply = this.reply;
    if (!reply || this.export.off()) return;
    this.querySelector("#insights-export-dialog")?.remove();
    // Confirm sends what the dialog counted, even if a load lands meanwhile.
    this.exportAsk = {
      body: exportBody(
        this.kind,
        this.state,
        this.period ?? periodOf(reply.meta.interval),
      ),
      count: reply.total,
    };
    this.insertAdjacentHTML(
      "beforeend",
      exportDialogView({ kind: this.kind, count: reply.total }),
    );
    /** @type {HTMLDialogElement} */ (
      this.querySelector("#insights-export-dialog")
    ).showModal();
  }

  /** @param {Event} event */
  dialogClosed = (event) => {
    const dialog = /** @type {HTMLDialogElement} */ (event.target);
    if (dialog.id !== "insights-export-dialog") return;
    const confirmed = dialog.returnValue === "confirm";
    const ask = this.exportAsk;
    this.exportAsk = null;
    dialog.remove();
    if (confirmed && ask)
      void this.session.exportJobs[this.kind].startWith(ask.body, ask.count);
    // The button shows the export's progress, so focus stays on it.
    /** @type {HTMLElement | null} */ (
      this.querySelector("#insights-export")
    )?.focus();
  };
}

if (!customElements.get("insights-raw-list"))
  customElements.define("insights-raw-list", InsightsRawList);
