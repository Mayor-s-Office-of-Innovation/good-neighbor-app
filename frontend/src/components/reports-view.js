/*
  reports-view — the site manager's reports, starting with Checks: how the
  site is doing against its checks-per-day duty over a week, month, or
  quarter. Manager-only (app-root gates the route; this element re-checks).
  Lazy-loaded chunk: nothing here is imported by main.js.

    /reports?period=month&start=YYYY-MM-DD   <reports-view>
    /reports/checks/YYYY-MM-DD               <reports-day-view>

  Data comes from the manager report endpoints (services/api.js). The site
  switcher is the same element the home hub uses; switching reloads onto
  /reports. Markup lives in reports-view.templates.js.
*/
import "./reports-view.css";
import "./site-switcher.js";
import "@awesome.me/webawesome/dist/components/select/select.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import {
  clearSiteSession,
  countUnsentWork,
  getSite,
  hasAdminAccess,
  listBoundSites,
} from "../db.js";
import { retireHandoff } from "../services/session-handoff.js";
import { openOverlayDialog } from "../dialog-history.js";
import { getLocale, setLocale, t } from "../i18n/i18n.js";
import { discardInMemorySession } from "../state/check-session.js";
import { currentRoute, navigate } from "../router.js";
import { announceScreenHeading } from "../screen-focus.js";
import {
  get311RequestDetails,
  getCheck,
  getChecksReport,
  getTasksReport,
  getTaskUpdatesReport,
} from "../services/api.js";
import { fetchProviderSites } from "../services/provider-sites.js";
import { switchToBoundSite } from "../services/site-switch.js";
import {
  cachedMediaUrls,
  hydrateTaskEvidence,
  hydrateTaskEvidenceFromCheck,
  needsTaskEvidenceHydration,
} from "../services/task-evidence.js";
import {
  map311StatusResponse,
  submitted311Requests,
  taskWith311Status,
} from "../domain/task-311-status.js";
import { TaskSheets } from "./task-sheets.js";
import {
  showLanguageErrorToast,
  showSiteCatalogErrorToast,
} from "../state/toasts.js";
import {
  daysToCsv,
  isDayKey,
  isPeriodKind,
  periodContaining,
  periodEnd,
  periodOptions,
} from "../domain/reports-periods.js";
import {
  filterReportIssues,
  isIssue,
  resolvedInPeriod,
  issuesOfType,
  issuesToCsv,
} from "../domain/reports-issues.js";
import {
  REPORT_TABS,
  TYPE_ROWS,
  checksTab,
  dayDetail,
  issuesTab,
  dayNotFound,
  errorBlock,
  loadingBlock,
  periodFilters,
  reportsShell,
  typeScreen,
} from "./reports-view.templates.js";

const RECORD_PAGE = 10;

/** Today's Pacific day key, from the report when we have one. */
function todayFrom(report) {
  return report?.today || new Date().toISOString().slice(0, 10);
}

/**
 * Shared site-switcher plumbing for both report screens: load the provider
 * catalog and this device's bindings, mount the persistent element, and
 * route a chosen site through the shared switch service.
 */
class ReportsScreen extends HTMLElement {
  constructor() {
    super();
    this._site = null;
    this._siteId = "";
    this._providerSites = [];
    this._providerName = "";
    this._providerSitesStatus = "idle";
    this._boundSites = [];
    /** @type {any} */
    this._siteSwitcher = null;
  }

  /** @returns {Promise<boolean>} whether the caller may continue */
  async _requireManager() {
    this._site = await getSite();
    if (!hasAdminAccess(this._site)) {
      navigate("/today");
      return false;
    }
    this._siteId =
      this._site.siteId || this._site.providerSiteId || this._site.id || "";
    return true;
  }

  async _loadCatalog() {
    this._providerSitesStatus = "loading";
    const [catalog, bindings] = await Promise.all([
      fetchProviderSites().catch((error) => {
        console.error("listProviderSites failed", error);
        showSiteCatalogErrorToast();
        return null;
      }),
      listBoundSites(),
    ]);
    this._providerSitesStatus = catalog ? "loaded" : "error";
    this._providerSites = catalog?.sites || [];
    this._providerName =
      catalog?.providerName || this._site?.providerName || "";
    this._boundSites = bindings;
  }

  /** @param {string} destination */
  _mountSiteSwitcher(destination) {
    if (!this._siteSwitcher) {
      const switcher = document.createElement("site-switcher");
      switcher.addEventListener("switchsite", (event) => {
        void this._switchToSite(
          /** @type {CustomEvent} */ (event).detail.siteId || "",
          destination,
        );
      });
      switcher.addEventListener("retrysites", () => {
        void this._loadCatalog().then(() =>
          this._mountSiteSwitcher(destination),
        );
      });
      this._siteSwitcher = switcher;
    }
    const switcher = this._siteSwitcher;
    switcher.providerName = this._providerName;
    switcher.sites = this._providerSites;
    switcher.currentSite = {
      siteId: this._siteId,
      name: this._site?.name || "",
    };
    switcher.status = this._providerSitesStatus;
    this.querySelector("site-switcher")?.replaceWith(switcher);
    switcher.render?.();
  }

  /** @param {string} siteId @param {string} destination */
  async _switchToSite(siteId, destination) {
    const outcome = await switchToBoundSite({
      siteId,
      currentSiteId: this._siteId,
      boundSites: this._boundSites,
      destination,
    });
    if (outcome === "same") {
      this._siteSwitcher?.close();
      return;
    }
    if (outcome === "needs-binding") {
      const target = this._providerSites.find((site) => site.siteId === siteId);
      this._siteSwitcher?.close();
      this.dispatchEvent(
        new CustomEvent("siterequested", {
          bubbles: true,
          detail: { siteId, siteName: target?.name || "", mode: "code" },
        }),
      );
    }
  }
}

class ReportsView extends ReportsScreen {
  constructor() {
    super();
    /** @type {"checks" | "issues"} */
    this._tab = "checks";
    this._resolvedOnly = false;
    this._issueFilter = "";
    this._cardHydrated = new Set();
    /** @type {TaskSheets | null} */
    this._issueSheets = null;
    /** @type {"week" | "month" | "quarter"} */
    this._kind = "month";
    this._start = "";
    this._report = null;
    this._status = "loading";
    this._shown = RECORD_PAGE;
    this._shownTypes = TYPE_ROWS;
    this._generation = 0;
    /** @type {string | null} id of the control to refocus after a render */
    this._refocus = null;
    this._settingsMenuOpen = false;
    this._logoutDialogOpen = false;
    this._logoutPending = false;
    this._logoutError = "";
    /** @type {{ checks?: number, careLogs?: number }} */
    this._logoutUnsent = {};
    this._onDocumentClick = (/** @type {Event} */ event) => {
      if (!this._settingsMenuOpen) return;
      const path = event.composedPath?.() || [];
      const inside = path.some(
        (node) =>
          node instanceof Element && node.matches(".home-settings-wrap"),
      );
      if (!inside) this._toggleSettingsMenu(false);
    };
  }

  disconnectedCallback() {
    document.removeEventListener("click", this._onDocumentClick);
  }

  async connectedCallback() {
    if (!(await this._requireManager())) return;
    document.addEventListener("click", this._onDocumentClick);
    const params = new URLSearchParams(window.location.search);
    this._issueFilter = ["resolved", "unresolved"].includes(
      params.get("status"),
    )
      ? params.get("status")
      : "";
    this._resolvedOnly = this._issueFilter === "resolved";
    const tab = params.get("tab");
    if (tab === "issues" || tab === "checks") this._tab = tab;
    const kind = params.get("period");
    if (isPeriodKind(kind)) this._kind = kind;
    const start = params.get("start");
    if (isDayKey(start)) this._start = start;
    this._render();
    announceScreenHeading(this, "[data-screen-focus]");
    void this._loadCatalog().then(() => this._mountSiteSwitcher("/reports"));
    await this._loadReport();
  }

  async _loadReport() {
    const generation = ++this._generation;
    this._status = "loading";
    this._render();
    try {
      const query = { period: this._kind, start: this._start || undefined };
      const [tasksReport, checksReport] = await Promise.all([
        getTasksReport(query),
        this._tab === "checks" ? getChecksReport(query) : null,
      ]);
      /** @type {any} */
      const report = checksReport
        ? { ...checksReport, tasks: tasksReport.tasks }
        : tasksReport;
      if (this._tab === "checks") {
        for (const day of report.days) {
          for (const check of day.checks || []) {
            const issues = report.tasks.filter(
              (task) => isIssue(task) && task.checkId === check.checkId,
            );
            check.issueCount = issues.length;
            check.resolvedCount = issues.filter((task) =>
              resolvedInPeriod(task, report.period),
            ).length;
          }
        }
      }
      if (generation !== this._generation || !this.isConnected) return;
      this._report = report;
      this._cardHydrated.clear();
      // The server resolves the period; mirror it so the URL and the pickers
      // always describe what is on screen.
      this._kind = report.period.kind;
      this._start = report.period.start;
      this._status = "loaded";
      this._syncUrl();
    } catch (error) {
      if (generation !== this._generation || !this.isConnected) return;
      console.error("checks report failed", error);
      this._status = "error";
    }
    this._render();
    if (this._status === "loaded") await this._hydrateIssueCards();
  }

  _syncUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", this._tab);
    if (this._issueFilter && this._tab === "issues")
      url.searchParams.set("status", this._issueFilter);
    else url.searchParams.delete("status");
    url.searchParams.set("period", this._kind);
    url.searchParams.set("start", this._start);
    window.history.replaceState(window.history.state, "", url);
  }

  /** @param {string} tabId */
  _activateTab(tabId) {
    const tab = REPORT_TABS.some((entry) => entry.id === tabId)
      ? /** @type {"checks" | "issues"} */ (tabId)
      : "checks";
    if (tab === this._tab) return;
    this._tab = tab;
    this._resolvedOnly = false;
    this._issueFilter = "";
    this._report = null;
    this._shown = RECORD_PAGE;
    this._shownTypes = TYPE_ROWS;
    this._refocus = "reports-tab-current";
    void this._loadReport();
  }

  _render() {
    const today = todayFrom(this._report);
    const selected = this._start
      ? periodContaining(this._kind, this._start)
      : periodContaining(this._kind, today);
    const options = periodOptions(this._kind, today);
    if (!options.some((p) => p.start === selected.start))
      options.push(selected);
    const filters = periodFilters({
      kind: this._kind,
      options,
      selectedStart: selected.start,
    });
    let body;
    if (this._status === "error") body = filters + errorBlock();
    else if (this._status === "loading" || !this._report)
      body = filters + loadingBlock();
    else if (this._tab === "issues")
      body = issuesTab({
        report: /** @type {any} */ (this._report),
        filters,
        shown: this._shown,
        shownTypes: this._shownTypes,
        filter: this._issueFilter,
        siteName: this._site?.name || "",
      });
    else
      body = checksTab({
        report: /** @type {any} */ (this._report),
        filters,
        shown: this._shown,
      });

    this.innerHTML = reportsShell({
      heading: t("reports.title"),
      body,
      tab: this._tab,
      settingsMenuOpen: this._settingsMenuOpen,
      logoutError: this._logoutError,
      logoutPending: this._logoutPending,
      logoutUnsent: this._logoutUnsent,
    });
    this._mountSiteSwitcher("/reports");
    this._wire();
    this._wireSettings();
    if (this._tab === "issues" && this._status === "loaded")
      this._mountIssueCards();
    this._restoreFocus();
  }

  /** @param {boolean} [open] */
  _toggleSettingsMenu(open = !this._settingsMenuOpen) {
    if (open === this._settingsMenuOpen) return;
    this._settingsMenuOpen = open;
    this._refocus = "home-settings";
    this._render();
  }

  /**
   * The same gear menu as the home hub (template shared), with the three
   * dialogs it opens. Site admin and Reports are plain navigations; the
   * feedback sheet is its own element; language, attributions, and logout
   * are overlay dialogs so system back closes them.
   */
  _wireSettings() {
    const feedback = /** @type {any} */ (this.querySelector("feedback-dialog"));
    if (feedback) feedback.siteId = this._siteId;
    this.querySelector("#home-settings")?.addEventListener("click", () =>
      this._toggleSettingsMenu(),
    );
    /** @param {() => void} action */
    const choose = (action) => {
      this._settingsMenuOpen = false;
      this.querySelector(".home-settings-menu")?.remove();
      this.querySelector("#home-settings")?.setAttribute(
        "aria-expanded",
        "false",
      );
      action();
    };
    this.querySelector("#settings-help")?.addEventListener("click", () => {
      this._settingsMenuOpen = false;
      navigate("/help");
    });
    this.querySelector("#settings-feedback")?.addEventListener("click", () =>
      choose(() => feedback?.open()),
    );
    this.querySelector("#settings-access")?.addEventListener("click", () =>
      navigate("/manage-access"),
    );
    this.querySelector("#settings-site-admin")?.addEventListener("click", () =>
      choose(() => navigate("/site-admin")),
    );
    this.querySelector("#settings-reports")?.addEventListener("click", () =>
      choose(() => {}),
    );
    const language = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#language-dialog")
    );
    this.querySelector("#settings-language")?.addEventListener("click", () =>
      choose(() => language && openOverlayDialog(language, "language")),
    );
    language?.addEventListener("close", () => {
      const chosen = language.returnValue || "";
      language.returnValue = "";
      if (chosen && chosen !== getLocale()) {
        void setLocale(chosen).then((ok) => {
          if (!ok) showLanguageErrorToast();
        });
        return;
      }
      /** @type {HTMLElement | null} */ (
        this.querySelector("#home-settings")
      )?.focus();
    });
    const attributions = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#attributions-dialog")
    );
    this.querySelector("#settings-attributions")?.addEventListener(
      "click",
      () =>
        choose(
          () => attributions && openOverlayDialog(attributions, "attributions"),
        ),
    );
    attributions?.addEventListener("close", () => {
      /** @type {HTMLElement | null} */ (
        this.querySelector("#home-settings")
      )?.focus();
    });
    const logout = /** @type {HTMLDialogElement | null} */ (
      this.querySelector("#logout-dialog")
    );
    this.querySelector("#settings-logout")?.addEventListener("click", () =>
      choose(() => {
        // Count first: logging out deletes work that hasn't uploaded yet.
        // The re-render opens the dialog with the counts.
        void countUnsentWork()
          .catch(() => ({}))
          .then((unsent) => {
            this._logoutUnsent = unsent;
            this._logoutDialogOpen = true;
            this._render();
          });
      }),
    );
    logout?.addEventListener("close", () => {
      this._logoutDialogOpen = false;
    });
    this.querySelector("#logout-confirm")?.addEventListener("click", () =>
      this._logout(),
    );
    for (const dialog of [language, attributions, logout]) {
      dialog?.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
    // A re-render while the logout dialog is up (pending / error) rebuilds
    // it closed; re-open it so the state change is visible.
    if (this._logoutDialogOpen && logout && !logout.open) {
      openOverlayDialog(logout, "logout");
    }
  }

  async _logout() {
    if (this._logoutPending) return;
    this._logoutPending = true;
    this._logoutError = "";
    this._render();
    try {
      // Before the session goes: retire the Home Screen handoff grant and
      // put the static manifest back (services/session-handoff.js).
      await retireHandoff();
      await clearSiteSession();
      discardInMemorySession();
      this._logoutDialogOpen = false;
      window.dispatchEvent(new CustomEvent("authsignout"));
    } catch {
      this._logoutPending = false;
      this._logoutError = t("today.logout.error");
      this._render();
    }
  }

  _wire() {
    const tabs = this.querySelectorAll("[data-report-tab]");
    tabs.forEach((button) => {
      button.addEventListener("click", () =>
        this._activateTab(button.getAttribute("data-report-tab") || ""),
      );
      button.addEventListener("keydown", (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
        event.preventDefault();
        const index = REPORT_TABS.findIndex((entry) => entry.id === this._tab);
        const next =
          key === "Home"
            ? 0
            : key === "End"
              ? REPORT_TABS.length - 1
              : (index + (key === "ArrowRight" ? 1 : -1) + REPORT_TABS.length) %
                REPORT_TABS.length;
        this._activateTab(REPORT_TABS[next].id);
      });
    });
    const kindSelect = /** @type {any} */ (this.querySelector("#reports-kind"));
    kindSelect?.addEventListener("change", () => {
      const value = String(kindSelect.value || "");
      if (!isPeriodKind(value) || value === this._kind) return;
      this._kind = value;
      this._start = "";
      this._shown = RECORD_PAGE;
      this._refocus = "reports-kind";
      void this._loadReport();
    });
    const periodSelect = /** @type {any} */ (
      this.querySelector("#reports-period")
    );
    periodSelect?.addEventListener("change", () => {
      const value = String(periodSelect.value || "");
      if (!isDayKey(value) || value === this._start) return;
      this._start = value;
      this._shown = RECORD_PAGE;
      this._refocus = "reports-period";
      void this._loadReport();
    });
    this.querySelector("#reports-retry")?.addEventListener("click", () => {
      void this._loadReport();
    });
    this.querySelector("#reports-show-more")?.addEventListener("click", (e) => {
      const next = Number(
        /** @type {HTMLElement} */ (e.currentTarget).getAttribute("data-next"),
      );
      this._shown = next || this._shown + RECORD_PAGE;
      this._refocus = "reports-show-more";
      this._render();
      void this._hydrateIssueCards();
    });
    this.querySelector("#reports-export")?.addEventListener("click", () =>
      this._exportCsv(),
    );
    this.querySelector("#reports-types-all")?.addEventListener("click", () => {
      this._shownTypes = Number.POSITIVE_INFINITY;
      this._refocus = "reports-types-first-extra";
      this._render();
    });
  }

  _issueTasks() {
    return filterReportIssues(
      (this._report?.tasks || []).filter(isIssue),
      this._report,
      this._issueFilter,
    )
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async _hydrateIssueCards() {
    if (this._tab !== "issues" || !this._report) return;
    const generation = this._generation;
    const pending = this._issueTasks()
      .slice(0, this._shown)
      .filter((task) => !this._cardHydrated.has(task.taskId));
    if (!pending.length) return;
    try {
      const requests = submitted311Requests(pending);
      const [hydrated, statuses] = await Promise.all([
        hydrateTaskEvidence(
          pending.map((task) => ({
            ...task,
            siteAddress: task.siteAddress || this._site?.address || "",
          })),
        ),
        requests.length
          ? get311RequestDetails(requests)
              .then(map311StatusResponse)
              .catch(() => new Map())
          : new Map(),
      ]);
      if (generation !== this._generation || !this.isConnected) return;
      const replacements = new Map(
        hydrated.map((task) => [
          task.taskId,
          taskWith311Status(task, statuses),
        ]),
      );
      this._report.tasks = this._report.tasks.map(
        (task) => replacements.get(task.taskId) || task,
      );
      for (const task of pending) this._cardHydrated.add(task.taskId);
      const active = document.activeElement;
      if (active && this.contains(active) && active.id)
        this._refocus = active.id;
      this._render();
    } catch (error) {
      console.error("report evidence failed", error);
    }
  }

  _mountIssueCards() {
    const resolveTask = (task) =>
      this._report?.tasks.find((row) => row.taskId === task.taskId) || task;
    if (!this._issueSheets)
      this._issueSheets = new TaskSheets({
        host: this,
        container: () => this.querySelector(":scope > .reports"),
        resolveTask,
        reload: () => this._loadReport(),
        fallbackFocus: () => this.querySelector("[data-screen-focus]"),
      });
    this._issueSheets.site = this._site;
    this._issueSheets.mount();
    this.querySelectorAll("[data-issue-filter]").forEach((button) =>
      button.addEventListener("click", () => {
        this._issueFilter = button.getAttribute("data-issue-filter") || "";
        this._resolvedOnly = this._issueFilter === "resolved";
        this._shown = RECORD_PAGE;
        this._refocus = this._issueFilter
          ? button.id
          : "reports-metric-unresolved";
        this._syncUrl();
        this._render();
        void this._hydrateIssueCards();
      }),
    );
    this.querySelector(".reports-type__cards")?.addEventListener(
      "click",
      (event) => {
        const button = /** @type {HTMLElement} */ (event.target).closest?.(
          "[data-action]",
        );
        const taskId = button
          ?.closest("[data-task-id]")
          ?.getAttribute("data-task-id");
        const task = this._report.tasks.find((row) => row.taskId === taskId);
        if (!(button instanceof HTMLElement) || !task) return;
        if (button.getAttribute("data-action") === "view311")
          this._issueSheets?.open311(task, button);
        else if (button.getAttribute("data-action") === "update")
          void this._issueSheets?.openUpdates(task, button);
      },
    );
  }

  async _restoreFocus() {
    const id = this._refocus;
    if (!id) return;
    // The loading render and the loaded render both replace the control;
    // keep the target until the loaded one so focus lands on the final DOM.
    if (this._status !== "loading") this._refocus = null;
    const target = /** @type {any} */ (
      id === "reports-tab-current"
        ? this.querySelector(".home-tabs__tab--active")
        : id === "reports-types-first-extra"
          ? this.querySelectorAll(".reports-types__link")[TYPE_ROWS]
          : this.querySelector(`#${id}`)
    );
    if (!target) return;
    await target.updateComplete;
    if (target.isConnected) target.focus({ preventScroll: true });
  }

  _exportCsv() {
    const report = /** @type {any} */ (this._report);
    if (!report) return;
    const csv =
      this._tab === "issues"
        ? issuesToCsv(this._issueTasks())
        : daysToCsv(report.days);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = t(
      this._tab === "issues"
        ? "reports.export.issuesFilename"
        : "reports.export.filename",
      {
        start: report.period.start,
        end: periodEnd(report.period),
      },
    );
    link.hidden = true;
    this.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

class ReportsDayView extends ReportsScreen {
  constructor() {
    super();
    /** @type {TaskSheets | null} the 311 and updates sheets, created on first use */
    this._sheets = null;
    /** @type {Map<string, any>} the day's tasks as rendered, by id */
    this._tasksById = new Map();
    this._loadGeneration = 0;
    this._rendered = false;
  }

  async connectedCallback() {
    if (!(await this._requireManager())) return;
    const date = currentRoute().split("/").pop() || "";
    if (!isDayKey(date)) {
      this.innerHTML = dayNotFound();
      announceScreenHeading(this, "[data-screen-focus]");
      return;
    }
    this.innerHTML = loadingBlock();
    this._rendered = false;
    await this._load(date);
  }

  /**
   * Fetch the day and render it. A refresh (after a sheet recorded an
   * update) keeps the current markup until the new one is ready, so an open
   * sheet is detached and re-mounted within one render.
   * @param {string} date
   */
  async _load(date) {
    const generation = ++this._loadGeneration;
    const isCurrent = () =>
      this.isConnected && generation === this._loadGeneration;
    try {
      const [report, tasksReport] = await Promise.all([
        getChecksReport({ period: "week", start: date }),
        getTasksReport({ period: "week", start: date }),
      ]);
      if (!isCurrent()) return;
      const day = report.days.find((d) => d.date === date);
      if (
        !day ||
        day.status === "upcoming" ||
        (!day.checkIds.length && day.status === "exempt")
      ) {
        this.innerHTML = dayNotFound();
        announceScreenHeading(this, "[data-screen-focus]");
        return;
      }
      const checks = (
        await Promise.all(
          day.checkIds.map((checkId) =>
            this._loadCheck(checkId, tasksReport.tasks || []),
          ),
        )
      ).filter(Boolean);
      const statuses = await this._load311Statuses(
        checks.flatMap((detail) => detail.tasks),
      );
      if (!isCurrent()) return;
      for (const detail of checks) {
        detail.tasks = detail.tasks.map((task) =>
          taskWith311Status(task, statuses),
        );
      }
      this._tasksById = new Map(
        checks.flatMap((detail) => detail.tasks.map((t) => [t.taskId, t])),
      );
      this.innerHTML = dayDetail({
        day,
        today: report.today,
        checks,
        siteName: this._site?.name || "",
      });
      // A refresh keeps focus where the sheet left it; only the first
      // render of the screen announces its heading.
      if (!this._rendered) announceScreenHeading(this, "[data-screen-focus]");
      this._rendered = true;
      const params = new URLSearchParams(window.location.search);
      const kind = params.get("period");
      const start = params.get("start");
      if (isPeriodKind(kind) && isDayKey(start)) {
        this.querySelector(".reports-day__back")?.setAttribute(
          "href",
          `/reports?tab=checks&period=${kind}&start=${start}`,
        );
      }
      this._mountSheets();
      this._wireCards();
    } catch (error) {
      if (!isCurrent()) return;
      console.error("day detail failed", error);
      this.innerHTML = errorBlock();
      this.querySelector("#reports-retry")?.addEventListener("click", () => {
        void this.connectedCallback();
      });
    }
  }

  _refresh() {
    const date = currentRoute().split("/").pop() || "";
    return isDayKey(date) ? this._load(date) : Promise.resolve();
  }

  /**
   * Live SF311 status for the day's filed tickets, one batch. Silent on
   * failure: the card then shows the task's own latest update label.
   * @param {any[]} tasks
   */
  async _load311Statuses(tasks) {
    const requests = submitted311Requests(tasks);
    if (!requests.length) return new Map();
    try {
      return map311StatusResponse(await get311RequestDetails(requests));
    } catch {
      return new Map();
    }
  }

  _mountSheets() {
    if (!this._sheets) {
      this._sheets = new TaskSheets({
        host: this,
        container: () => this.querySelector(":scope > .reports-day"),
        resolveTask: (task) => this._tasksById.get(task.taskId) || task,
        reload: () => this._refresh(),
        fallbackFocus: () => this.querySelector("[data-screen-focus]"),
      });
    }
    this._sheets.site = this._site;
    this._sheets.mount();
  }

  /** One delegated listener per render: the timeline is rebuilt each time. */
  _wireCards() {
    this.querySelector(".reports-timeline")?.addEventListener(
      "click",
      (event) => {
        const button = /** @type {HTMLElement | null} */ (
          /** @type {HTMLElement} */ (event.target).closest?.("[data-action]")
        );
        const card = button?.closest("[data-task-id]");
        const task = card
          ? this._tasksById.get(card.getAttribute("data-task-id") || "")
          : null;
        if (!button || !task) return;
        const action = button.getAttribute("data-action");
        if (action === "view311") this._sheets?.open311(task, button);
        else if (action === "add-proof")
          void this._sheets?.openUpdates(task, button, "results");
        else if (action === "mark-resolved")
          void this._sheets?.openUpdates(task, button, "resolve");
        else if (action === "update")
          void this._sheets?.openUpdates(task, button);
      },
    );
  }

  /**
   * One check's header, all capture photos, and the tasks it produced,
   * hydrated with their place, street, and thumbnail from the same detail.
   * A failed check read fails the view rather than silently omitting a record. Superseded tasks were replaced by an amendment and are not
   * issues in their own right (same rule as the Issues tab).
   * @param {string} checkId
   * @param {any[]} tasks
   */
  async _loadCheck(checkId, tasks) {
    let detail;
    try {
      detail = await getCheck(checkId);
    } catch (error) {
      console.warn("check detail failed", { checkId, error });
      throw error;
    }
    const artifacts = (detail.artifacts || []).filter(
      (a) => a.artifactId && !a.purpose,
    );
    const photos = artifacts.filter(
      (a) => a.s3Key && String(a.contentType || "").startsWith("image/"),
    );
    const checkTasks = tasks
      .filter(
        (task) => task.checkId === checkId && task.status !== "superseded",
      )
      .map((task) => ({
        ...task,
        siteAddress: task.siteAddress || this._site?.address || "",
      }));
    const [urls, hydratedTasks] = await Promise.all([
      Promise.all(
        photos.map((a) =>
          cachedMediaUrls(checkId, a.artifactId).catch(() => null),
        ),
      ),
      hydrateTaskEvidenceFromCheck(checkTasks, detail),
    ]);
    const evidence = [
      ...photos.map((a, i) => ({
        artifactId: a.artifactId,
        kind: "photo",
        url: urls[i]?.downloadUrl || "",
        thumbnailUrl: urls[i]?.thumbnailUrl,
      })),
      ...artifacts
        .filter((a) => a.text)
        .map((a) => ({ artifactId: a.artifactId, kind: "text" })),
    ];
    return { check: detail.check, evidence, tasks: hydratedTasks };
  }
}

/**
 * One issue type's reports in a period: /reports/issues/<key>?period&start.
 * Cards are hydrated a page at a time (place, street, thumbnail, 311
 * status), since a month at a busy site spans dozens of checks.
 */
class ReportsTypeView extends ReportsScreen {
  constructor() {
    super();
    this._key = "";
    this._filter = "";
    this._requests = new Map();
    /** @type {"week" | "month" | "quarter"} */
    this._kind = "month";
    this._start = "";
    /** @type {any} */
    this._report = null;
    this._shown = RECORD_PAGE;
    /** @type {Map<string, any>} hydrated copies by task id */
    this._hydrated = new Map();
    /** @type {Map<string, import("../domain/task-311-status.js").Ticket311State>} */
    this._statuses = new Map();
    /** @type {Map<string, any>} the tasks as rendered, by id */
    this._tasksById = new Map();
    /** @type {TaskSheets | null} */
    this._sheets = null;
    this._generation = 0;
    this._rendered = false;
    /** @type {string | null} */
    this._refocus = null;
  }

  async connectedCallback() {
    if (!(await this._requireManager())) return;
    const route = currentRoute();
    this._key = decodeURIComponent(route.split("/").pop() || "");
    const params = new URLSearchParams(window.location.search);
    this._filter =
      params.get("status") === "resolved"
        ? "resolved"
        : params.get("filter") || "";
    if (
      !["", "resolved", "unresolved", "aged", "awaiting", "noAction"].includes(
        this._filter,
      )
    )
      this._filter = "";
    const kind = params.get("period");
    if (isPeriodKind(kind)) this._kind = kind;
    const start = params.get("start");
    if (isDayKey(start)) this._start = start;
    this.innerHTML = loadingBlock();
    this._rendered = false;
    await this._load();
  }

  async _load() {
    const generation = ++this._generation;
    try {
      /** @type {any} */
      const report = await getTasksReport({
        period: this._kind,
        start: this._start || undefined,
      });
      if (generation !== this._generation || !this.isConnected) return;
      const [updates, tickets] = await Promise.all([
        getTaskUpdatesReport({
          period: report.period.kind,
          start: report.period.start,
        }),
        submitted311Requests(issuesOfType(report.tasks, this._key)).length
          ? get311RequestDetails(
              submitted311Requests(issuesOfType(report.tasks, this._key)),
            ).catch(() => null)
          : { requests: [] },
      ]);
      if (generation !== this._generation || !this.isConnected) return;
      report.updates = updates.updates;
      report.ticketStatusUnavailable =
        tickets === null ||
        (tickets.requests || []).length <
          submitted311Requests(issuesOfType(report.tasks, this._key)).length ||
        (tickets.requests || []).some(
          ({ request }) =>
            !request?.status ||
            (report.period.endExclusive <= report.today &&
              request.status === "Closed" &&
              !(request.events || []).some(
                (event) =>
                  event.occurredAt &&
                  (event.kind === "resolved" ||
                    (event.kind === "statusChanged" &&
                      event.value === "Closed")),
              )),
        );
      this._requests = new Map(
        (tickets?.requests || []).map((entry) => [entry.taskId, entry.request]),
      );
      this._statuses = map311StatusResponse(tickets);
      this._hydrated.clear();
      this._report = report;
      this._kind = report.period.kind;
      this._start = report.period.start;
      this._syncUrl();
      this._render();
      await this._hydrateVisible(generation);
    } catch (error) {
      if (generation !== this._generation || !this.isConnected) return;
      console.error("type report failed", error);
      this.innerHTML = errorBlock();
      this.querySelector("#reports-retry")?.addEventListener("click", () => {
        void this.connectedCallback();
      });
    }
  }

  /**
   * The type's issues, newest first, with hydration and 311 status folded in.
   * @returns {any[]}
   */
  _tasks() {
    return issuesOfType(this._report?.tasks || [], this._key).map((task) => ({
      ...taskWith311Status(
        this._hydrated.get(task.taskId) || task,
        this._statuses,
      ),
      report311: this._requests.get(task.taskId),
    }));
  }

  _render() {
    if (!this._report) return;
    const tasks = this._tasks();
    this._tasksById = new Map(tasks.map((task) => [task.taskId, task]));
    this.innerHTML = typeScreen({
      report: { ...this._report, tasks },
      filter: this._filter,
      filters: this._filters(),
      key: this._key,
      shown: this._shown,
      siteName: this._site?.name || "",
    });
    if (!this._rendered) announceScreenHeading(this, "[data-screen-focus]");
    this._rendered = true;
    this._mountSheets();
    this._wire();
    this._restoreFocus();
  }

  /**
   * Evidence and live 311 status for the visible page only.
   * @param {number} generation
   */
  async _hydrateVisible(generation) {
    const visible = filterReportIssues(
      this._tasks(),
      this._report,
      this._filter,
    ).slice(0, this._shown);
    const pending = visible.filter(
      (task) =>
        needsTaskEvidenceHydration(task) && !this._hydrated.has(task.taskId),
    );
    const requests = [];
    if (!pending.length && !requests.length) return;
    const [hydrated, statuses] = await Promise.all([
      pending.length
        ? hydrateTaskEvidence(
            pending.map((task) => ({
              ...task,
              siteAddress: task.siteAddress || this._site?.address || "",
            })),
          )
        : [],
      requests.length
        ? get311RequestDetails(requests)
            .then(map311StatusResponse)
            .catch(() => new Map())
        : new Map(),
    ]);
    if (generation !== this._generation || !this.isConnected) return;
    for (const task of hydrated) this._hydrated.set(task.taskId, task);
    for (const [taskId, state] of statuses) this._statuses.set(taskId, state);
    const active = document.activeElement;
    if (active && this.contains(active) && active.id) this._refocus = active.id;
    this._render();
  }

  _mountSheets() {
    if (!this._sheets) {
      this._sheets = new TaskSheets({
        host: this,
        container: () => this.querySelector(":scope > .reports-type"),
        resolveTask: (task) => this._tasksById.get(task.taskId) || task,
        reload: () => this._load(),
        fallbackFocus: () => this.querySelector("[data-screen-focus]"),
      });
    }
    this._sheets.site = this._site;
    this._sheets.mount();
  }

  _filters() {
    const selected = this._report.period;
    const options = periodOptions(this._kind, todayFrom(this._report));
    if (!options.some((period) => period.start === selected.start))
      options.push(selected);
    return periodFilters({
      kind: this._kind,
      options,
      selectedStart: selected.start,
    });
  }

  _syncUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("period", this._kind);
    url.searchParams.set("start", this._start);
    url.searchParams.delete("status");
    if (this._filter) url.searchParams.set("filter", this._filter);
    else url.searchParams.delete("filter");
    window.history.replaceState(window.history.state, "", url);
  }

  _exportCsv() {
    const tasks = filterReportIssues(this._tasks(), this._report, this._filter);
    const url = URL.createObjectURL(
      new Blob([issuesToCsv(tasks)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = t("reports.export.issuesFilename", {
      start: this._start,
      end: periodEnd(this._report.period),
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _wire() {
    const kindSelect = /** @type {any} */ (this.querySelector("#reports-kind"));
    const periodSelect = /** @type {any} */ (
      this.querySelector("#reports-period")
    );
    kindSelect?.addEventListener("change", () => {
      if (!isPeriodKind(kindSelect.value) || kindSelect.value === this._kind)
        return;
      this._kind = kindSelect.value;
      this._start = "";
      this._shown = RECORD_PAGE;
      this._refocus = "reports-kind";
      void this._load();
    });
    periodSelect?.addEventListener("change", () => {
      if (!isDayKey(periodSelect.value) || periodSelect.value === this._start)
        return;
      this._start = periodSelect.value;
      this._shown = RECORD_PAGE;
      this._refocus = "reports-period";
      void this._load();
    });
    this.querySelector("#reports-export")?.addEventListener("click", () =>
      this._exportCsv(),
    );
    this.querySelectorAll("[data-issue-filter]").forEach((button) =>
      button.addEventListener("click", () => {
        this._filter = button.getAttribute("data-issue-filter") || "";
        this._shown = RECORD_PAGE;
        this._refocus = this._filter ? button.id : "reports-metric-unresolved";
        this._syncUrl();
        this._render();
        void this._hydrateVisible(this._generation);
      }),
    );
    this.querySelector("#reports-show-more")?.addEventListener("click", (e) => {
      const next = Number(
        /** @type {HTMLElement} */ (e.currentTarget).getAttribute("data-next"),
      );
      this._shown = next || this._shown + RECORD_PAGE;
      this._refocus = "reports-show-more";
      this._render();
      void this._hydrateVisible(this._generation);
    });
    this.querySelector(".reports-type__cards")?.addEventListener(
      "click",
      (event) => {
        const button = /** @type {HTMLElement | null} */ (
          /** @type {HTMLElement} */ (event.target).closest?.("[data-action]")
        );
        const card = button?.closest("[data-task-id]");
        const task = card
          ? this._tasksById.get(card.getAttribute("data-task-id") || "")
          : null;
        if (!button || !task) return;
        const action = button.getAttribute("data-action");
        if (action === "view311") this._sheets?.open311(task, button);
        else if (action === "add-proof")
          void this._sheets?.openUpdates(task, button, "results");
        else if (action === "mark-resolved")
          void this._sheets?.openUpdates(task, button, "resolve");
        else if (action === "update")
          void this._sheets?.openUpdates(task, button);
      },
    );
  }

  /**
   * After Show more: the button if it is still there, else the first newly
   * revealed card's updates row.
   */
  async _restoreFocus() {
    const id = this._refocus;
    if (!id) return;
    this._refocus = null;
    const target = /** @type {any} */ (
      this.querySelector(`#${id}`) ||
        this.querySelectorAll(".reports-type__cards > li")[
          this._shown - RECORD_PAGE
        ]?.querySelector("[data-action]")
    );
    if (!target) return;
    await target.updateComplete;
    if (target.isConnected) target.focus({ preventScroll: true });
  }
}

customElements.define("reports-view", ReportsView);
customElements.define("reports-day-view", ReportsDayView);
customElements.define("reports-type-view", ReportsTypeView);
