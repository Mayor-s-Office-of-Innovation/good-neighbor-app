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
  getSite,
  hasAdminAccess,
  listBoundSites,
} from "../db.js";
import { openOverlayDialog } from "../dialog-history.js";
import { getLocale, setLocale, t } from "../i18n/i18n.js";
import { discardInMemorySession } from "../state/check-session.js";
import { currentRoute, navigate } from "../router.js";
import { announceScreenHeading } from "../screen-focus.js";
import {
  getCheck,
  getChecksReport,
  getMediaUrl,
  getTasksReport,
} from "../services/api.js";
import { fetchProviderSites } from "../services/provider-sites.js";
import { switchToBoundSite } from "../services/site-switch.js";
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
import { issuesToCsv } from "../domain/reports-issues.js";
import {
  REPORT_TABS,
  checksTab,
  dayDetail,
  issuesTab,
  dayNotFound,
  errorBlock,
  loadingBlock,
  periodFilters,
  reportsShell,
} from "./reports-view.templates.js";

const RECORD_PAGE = 10;
const MAX_PHOTOS_PER_CHECK = 6;

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
    /** @type {"week" | "month" | "quarter"} */
    this._kind = "month";
    this._start = "";
    this._report = null;
    this._status = "loading";
    this._shown = RECORD_PAGE;
    this._generation = 0;
    /** @type {string | null} id of the control to refocus after a render */
    this._refocus = null;
    this._settingsMenuOpen = false;
    this._logoutDialogOpen = false;
    this._logoutPending = false;
    this._logoutError = "";
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
      const report =
        this._tab === "issues"
          ? await getTasksReport(query)
          : await getChecksReport(query);
      if (generation !== this._generation || !this.isConnected) return;
      this._report = report;
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
  }

  _syncUrl() {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", this._tab);
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
    this._report = null;
    this._shown = RECORD_PAGE;
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
    });
    this._mountSiteSwitcher("/reports");
    this._wire();
    this._wireSettings();
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
    this.querySelector("#settings-feedback")?.addEventListener("click", () =>
      choose(() => feedback?.open()),
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
        this._logoutDialogOpen = true;
        if (logout) openOverlayDialog(logout, "logout");
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
    });
    this.querySelector("#reports-export")?.addEventListener("click", () =>
      this._exportCsv(),
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
        ? issuesToCsv(report.tasks || [])
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
  async connectedCallback() {
    if (!(await this._requireManager())) return;
    const date = currentRoute().split("/").pop() || "";
    if (!isDayKey(date)) {
      this.innerHTML = dayNotFound();
      announceScreenHeading(this, "[data-screen-focus]");
      return;
    }
    this.innerHTML = loadingBlock();
    try {
      const [report, tasksReport] = await Promise.all([
        getChecksReport({ period: "week", start: date }),
        getTasksReport({ period: "week", start: date }),
      ]);
      if (!this.isConnected) return;
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
      const checks = await Promise.all(
        day.checkIds.map((checkId) =>
          this._loadCheck(checkId, tasksReport.tasks || []),
        ),
      );
      if (!this.isConnected) return;
      this.innerHTML = dayDetail({
        day,
        today: report.today,
        checks: checks.filter(Boolean),
      });
      announceScreenHeading(this, "[data-screen-focus]");
    } catch (error) {
      console.error("day detail failed", error);
      this.innerHTML = errorBlock();
      this.querySelector("#reports-retry")?.addEventListener("click", () => {
        void this.connectedCallback();
      });
    }
  }

  /**
   * One check's header, its evidence (signed photo URLs, bounded), and the
   * tasks it produced. A check that fails to load is dropped, not fatal.
   * @param {string} checkId
   * @param {any[]} tasks
   */
  async _loadCheck(checkId, tasks) {
    let detail;
    try {
      detail = await getCheck(checkId);
    } catch (error) {
      console.warn("check detail failed", { checkId, error });
      return null;
    }
    const artifacts = (detail.artifacts || []).filter(
      (a) => a.artifactId && !a.purpose,
    );
    const photos = artifacts
      .filter(
        (a) => a.s3Key && String(a.contentType || "").startsWith("image/"),
      )
      .slice(0, MAX_PHOTOS_PER_CHECK);
    const urls = await Promise.all(
      photos.map((a) =>
        getMediaUrl(checkId, a.artifactId)
          .then((r) => r.downloadUrl)
          .catch(() => ""),
      ),
    );
    const evidence = [
      ...photos.map((a, i) => ({
        artifactId: a.artifactId,
        kind: "photo",
        url: urls[i],
      })),
      ...artifacts
        .filter((a) => a.text)
        .map((a) => ({ artifactId: a.artifactId, kind: "text" })),
    ];
    return {
      check: detail.check,
      evidence,
      tasks: tasks.filter((task) => task.checkId === checkId),
    };
  }
}

customElements.define("reports-view", ReportsView);
customElements.define("reports-day-view", ReportsDayView);
