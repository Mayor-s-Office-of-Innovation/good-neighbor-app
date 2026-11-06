import { localRoleEnabled, getLocalRole, setLocalRole } from "./local-role.js";
import { complianceDraftAfterNavigation } from "./compliance-profile-draft.js";
import { t } from "../../frontend/src/i18n/i18n.js";
import {
  completeAdminLoginFromUrl,
  hasAdminSession,
  signOutAdmin,
  startAdminLogin,
} from "./services/admin-auth.js";
import { createAdminCatalog } from "./admin-catalog.js";
import { createAdminSession } from "./admin-session.js";
import { getAdminConfig } from "./config.js";
import { escapeHtml } from "./dom.js";
import { errorLineText } from "./admin-error-messages.js";
import { currentRoute, matchRoute, navigate } from "./router.js";
import { adminSettingsMenu } from "./pages/admin-user/admin-user.templates.js";
import "./pages/admin-user/admin-users-page.js";
import "./pages/directory/directory-page.js";
import "./pages/program/program-page.js";
import "./pages/provider/provider-page.js";
import "./pages/site/manager-page.js";
import { restartManagerLoad } from "./pages/site/manager-directory-read.js";
import "./pages/site/new-site-page.js";
import "./pages/site/site-import-page.js";
import "./pages/site/site-page.js";
import { insightsOn } from "./pages/insights/insights-page.js";
import {
  INSIGHTS_ROUTES,
  routeMode,
  signInReturnPath,
} from "./pages/insights/insights-routes.js";
import { modeMemory } from "./pages/insights/mode-memory.js";
import { modeNav } from "./pages/insights/shell.templates.js";

// One tag per route, so routes that share a page reuse its loaded lists.
const ROUTE_PAGES = {
  administrators: "admin-users-page",
  "administrator-new": "admin-users-page",
  profile: "admin-users-page",
  "site-import": "admin-site-import-page",
  "site-new": "admin-new-site-page",
  site: "admin-site-page",
  "manager-new": "admin-site-manager-page",
  manager: "admin-site-manager-page",
  "program-new": "admin-program-page",
  program: "admin-program-page",
  "provider-new": "admin-provider-page",
  provider: "admin-provider-page",
  "provider-manager": "admin-provider-page",
  sites: "admin-directory-page",
  managers: "admin-directory-page",
  providers: "admin-directory-page",
  programs: "admin-directory-page",
  "provider-managers": "admin-directory-page",
  ...Object.fromEntries(
    INSIGHTS_ROUTES.map(([name]) => [name, "admin-insights-page"]),
  ),
  analytics: "admin-insights-page",
};

// These page elements are thrown away on leaving, so a later visit can't flash the last record.
const DROPPED_ON_LEAVE = new Set([
  "admin-program-page",
  "admin-provider-page",
  "admin-site-manager-page",
]);

// A record already open stays under the sign-in panel when the session lapses,
// so its unsaved edits are still there after signing back in. Provider pages
// show enrollment codes, so they hide until the user signs in again.
const SHOWN_SIGNED_OUT = new Set(["site", "program", "manager"]);

export class AdminApp extends HTMLElement {
  // Kept so a page's state survives a visit elsewhere; DROPPED_ON_LEAVE pages aren't.
  /** @type {Record<string, any>} */
  pages = {};
  /** @type {any} */
  routePage = null;
  /** @type {any} */
  shownPage = null;
  /** @type {string | undefined} */
  openedRouteName = undefined;
  /** @type {string | undefined} */
  leaveDestination = undefined;
  // The open leave dialog's own token, so an older dialog closing late can't clear its destination.
  /** @type {object | undefined} */
  leavePrompt = undefined;
  // Its own, not module-wide, so a new <admin-app> never starts with an old one's lists or role.
  catalog = createAdminCatalog();
  session = createAdminSession();

  constructor() {
    super();
    this.state = this.freshState(false);
  }

  /** @param {boolean} hasToken */
  freshState(hasToken) {
    return {
      error: "",
      hasToken,
      authConfig: getAdminConfig(),
      authBusy: false,
    };
  }

  /** @returns {Promise<void>} */
  async connectedCallback() {
    // A manager directory read from before a remount may never settle, so start a fresh one.
    this.catalog.invalidate("managers");
    restartManagerLoad(this.catalog);
    // A reattached app reads the role again, so a failed read can't keep the old one.
    this.session.clear();
    this.dropPages();
    this.state = this.freshState(hasAdminSession());
    this.modes = modeMemory();
    const callback = await completeAdminLoginFromUrl().catch((err) => ({
      handled: true,
      error: err.message,
    }));
    if (callback.handled) {
      this.state.hasToken = hasAdminSession();
      this.state.error = errorLineText(callback.error || "", t);
      // Checked again, since another page could have written the stored path.
      const back = signInReturnPath(
        /** @type {{ returnTo?: string }} */ (callback).returnTo,
      );
      if (back && this.state.hasToken) history.replaceState({}, "", back);
    }
    this.render();
    this.addEventListener("click", this.onClick);
    this.addEventListener("change", this.onChange);
    this.addEventListener("page-error", this.showPageError);
    this.addEventListener("page-rendered", this.pageRendered);
    this.addEventListener("draft-recovery", this.draftRecovery);
    window.addEventListener("popstate", this.routeChanged);
    window.addEventListener("beforeunload", this.beforeUnload);
    if (this.state.hasToken) {
      const origin = location.pathname + location.search;
      this.bootstrap().catch((error) => {
        if (
          error.name === "AbortError" ||
          location.pathname + location.search !== origin
        )
          return;
        this.routeReadFailed = true;
        this.state.error = errorLineText(error, t);
        this.render();
      });
    }
  }

  disconnectedCallback() {
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("change", this.onChange);
    this.removeEventListener("page-error", this.showPageError);
    this.removeEventListener("page-rendered", this.pageRendered);
    this.removeEventListener("draft-recovery", this.draftRecovery);
    window.removeEventListener("popstate", this.routeChanged);
    window.removeEventListener("beforeunload", this.beforeUnload);
  }

  /** @param {Event} event */
  onClick = (event) => {
    this.routeClick(event);
    if (this.shellControl(event, "#sign-in")) void this.signIn();
    if (this.shellControl(event, "#clear-token")) this.signOut();
    if (this.shellControl(event, "#retry-page-load")) this.retryPageLoad();
    if (this.shellControl(event, "#retry-compliance-draft"))
      this.resumeComplianceDraft();
  };

  /** @param {Event} event */
  onChange = (event) => {
    const select = this.shellControl(event, "#local-role-switch");
    if (select) this.switchLocalRole(/** @type {HTMLSelectElement} */ (select));
  };

  /**
   * Only a control inside <admin-app> counts, since closest() can climb past it.
   * @param {Event} event
   * @param {string} selector
   * @returns {HTMLElement | null}
   */
  shellControl(event, selector) {
    const target = event.target instanceof Element ? event.target : null;
    const control = target?.closest(selector);
    return control instanceof HTMLElement && this.contains(control)
      ? control
      : null;
  }

  async signIn() {
    this.state.authBusy = true;
    this.state.error = "";
    this.render();
    // Only Insights pages come back after sign-in; Manage has always opened on the Site list.
    await startAdminLogin(
      signInReturnPath(location.pathname + location.search),
    ).catch((err) => {
      this.state.authBusy = false;
      this.state.error = errorLineText(err, t);
      this.render();
    });
  }

  signOut() {
    this.state.hasToken = false;
    this.catalog.clear();
    this.session.clear();
    this.dropPages();
    signOutAdmin();
  }

  /** Pages outlive a render, so drop them with the session: their unsaved edits belong to it. */
  dropPages() {
    for (const page of Object.values(this.pages)) page.leave?.();
    this.pages = {};
    this.routePage = this.shownPage = null;
    // A dialog removed without closing never answers, so stop waiting for it.
    this.leaveDestination = this.leavePrompt = undefined;
  }

  retryPageLoad() {
    if (!this.session.role) {
      window.location.reload();
      return;
    }
    this.routeChanged();
  }

  resumeComplianceDraft() {
    const draft = this.session.complianceDraft;
    if (!draft) return;
    draft.phase = "returning";
    this.state.error = "";
    navigate(`/sites/${encodeURIComponent(draft.siteId)}?section=compliance`);
  }

  /** @param {HTMLSelectElement} select */
  switchLocalRole(select) {
    if (
      this.hasEditsToLose() &&
      !window.confirm(t("admin.localRole.discard"))
    ) {
      select.value = getLocalRole();
      return;
    }
    setLocalRole(select.value);
    window.location.reload();
  }

  /** @param {Event} event */
  showPageError = (event) => {
    const text = errorLineText(
      /** @type {CustomEvent<Error>} */ (event).detail,
      t,
    );
    // Pages clear the line after most actions; redrawing <admin-app> for no change loses focus.
    if (text === this.state.error) return;
    this.state.error = text;
    this.render();
  };

  /** The Site page couldn't reopen the compliance draft, so show the button that retries it. */
  draftRecovery = () => this.render();

  /** Pages redraw without <admin-app>, so they report which path they now show. @param {Event} event */
  pageRendered = (event) => {
    this.lastRenderedPath = /** @type {CustomEvent<string>} */ (event).detail;
  };

  /** @param {BeforeUnloadEvent} event */
  beforeUnload = (event) => {
    if (!this.hasEditsToLose()) return;
    event.preventDefault();
    event.returnValue = "";
  };

  /** @param {any} event */
  routeClick = (event) => {
    const link = event.target.closest?.("a[data-route], button[data-navigate]");
    if (
      !link ||
      !this.contains(link) ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const destination =
      link.getAttribute("href") || link.dataset.navigate || "/sites";
    if (this.hasUnsavedChanges()) void this.leavePage(destination);
    else navigate(destination);
  };

  routeChanged = () => {
    const destination = window.location.pathname + window.location.search;
    if (
      this.lastRenderedPath &&
      destination !== this.lastRenderedPath &&
      this.hasUnsavedChanges(currentRoute())
    ) {
      window.history.pushState({}, "", this.lastRenderedPath);
      void this.leavePage(destination);
      return;
    }
    const from = this.lastRenderedPath || "";
    this.leaveModePage();
    this.session.complianceDraft = complianceDraftAfterNavigation(
      this.session.complianceDraft,
      destination,
    );
    this.routeReadFailed = false;
    this.state.error = "";
    if (
      !(
        currentRoute().name === "system-status" &&
        this.querySelector("system-status-view")
      )
    )
      this.render(true);
    this.openModeRoute(from, destination).catch((error) => {
      if (
        error.name === "AbortError" ||
        window.location.pathname + window.location.search !== destination
      )
        return;
      this.routeReadFailed = true;
      if (this.session.complianceDraft?.phase === "returning")
        this.session.complianceDraft.phase = "recovery";
      this.state.error = errorLineText(error, t);
      this.render();
    });
  };

  /**
   * Each page answers for its own edits and asks in its own dialog, so its tests need no <admin-app>.
   * @param {{ name: string, id?: string }} [next] where Back or Forward is going
   */
  hasUnsavedChanges(next) {
    return Boolean(this.shownPage?.hasUnsavedChanges?.(next));
  }

  /** Kept pages hold edits while loading or sign-in hides them, so a reload still warns. */
  hasEditsToLose() {
    // A page loading another record still holds the discarded form of the last one.
    return Object.values(this.pages).some(
      (page) =>
        page.route && page.shows(page.route) && page.hasUnsavedChanges?.(),
    );
  }

  /**
   * Go to `destination` once the page on screen says its edits can be dropped.
   * @param {string} destination
   */
  async leavePage(destination) {
    // Presses while the dialog is open share its answer, so Discard goes only to the latest.
    const asking = this.leaveDestination !== undefined;
    this.leaveDestination = destination;
    if (asking) return;
    const page = this.shownPage;
    const prompt = (this.leavePrompt = {});
    const current = () => {
      if (prompt !== this.leavePrompt) return false;
      this.leaveDestination = this.leavePrompt = undefined;
      return true;
    };
    const discard = await page.confirmLeave().catch((error) => {
      current();
      throw error;
    });
    const latest = /** @type {string} */ (this.leaveDestination);
    if (!current() || !discard || page !== this.shownPage) return;
    // Saved now, since the cleared path below stops the move saving this page.
    this.leaveModePage();
    // Skips routeChanged's check, since the user just chose to drop the edits.
    this.lastRenderedPath = "";
    navigate(latest);
  }

  leaveModePage() {
    // A page still loading was never seen, and its scroll is the previous page's.
    if (this.lastRenderLoading) return;
    const active = document.activeElement;
    const focus = active && this.contains(active) ? active.id : "";
    this.modes.leave(this.lastRenderedPath || "", window.scrollY, focus);
  }

  /** @param {string} from @param {string} destination */
  async openModeRoute(from, destination) {
    await this.openRoute();
    this.restoreModePage(from, destination);
  }

  /** @param {string} from @param {string} destination */
  restoreModePage(from, destination) {
    if (location.pathname + location.search !== destination) return;
    const fromMode = routeMode(matchRoute(from.split("?")[0]).name);
    const toMode = routeMode(currentRoute().name);
    if (fromMode !== "insights" && toMode !== "insights") return;
    const place = this.modes.arrive(destination);
    // With nothing saved, the browser's own Back scroll is left alone.
    if (place) window.scrollTo(0, place.scrollY);
    const saved = place?.focus ? document.getElementById(place.focus) : null;
    const target =
      saved && this.contains(saved) ? saved : this.querySelector("h1");
    // The scroll just restored would be lost to the heading scrolling into view.
    /** @type {HTMLElement | null} */ (target)?.focus({ preventScroll: true });
  }

  async bootstrap() {
    this.routeReadFailed = false;
    await this.session.load();
    this.render(true);
    await this.openRoute();
  }

  async openRoute() {
    const route = currentRoute();
    const path = location.pathname + location.search;
    /** @type {string | undefined} */
    const tag = /** @type {any} */ (ROUTE_PAGES)[route.name];
    // The route's own page is left too when the route changes, as from the users list to My profile.
    const newRoute = route.name !== this.openedRouteName;
    this.openedRouteName = route.name;
    for (const [kept, page] of Object.entries(this.pages)) {
      if (kept === tag && !newRoute) continue;
      // Kept pages stop their reads; DROPPED_ON_LEAVE pages are deleted, so they start clean next visit.
      page.leave?.(route);
      if (kept !== tag && DROPPED_ON_LEAVE.has(kept)) delete this.pages[kept];
    }
    this.routePage = null;
    if (route.name === "system-status") {
      await import("./system-status.js");
      if (location.pathname + location.search !== path) return;
      if (!this.session.capabilities.manageAdminUsers)
        return navigate("/sites", { replace: true });
      const status = /** @type {any} */ (
        this.querySelector("system-status-view")
      );
      if (status) {
        status.showView(route.id);
        this.lastRenderedPath = path;
        return;
      }
      this.render();
      /** @type {HTMLElement | null} */ (
        this.querySelector("#status-title")
      )?.focus();
      return;
    }
    if (!tag) return;
    const page = (this.pages[tag] ||= this.createPage(tag));
    this.routePage = page;
    // A newer visit replaced the page, so this one must not render or focus.
    if (!(await page.open(route)) || page !== this.routePage) return;
    // A page's own reload, such as after Suspend, leaves it on screen; redraw it with the new data.
    const onScreen = page.isConnected;
    this.render();
    if (onScreen) page.render();
    page.focusOnOpen();
  }

  /** @param {string} tag */
  createPage(tag) {
    const page = /** @type {any} */ (document.createElement(tag));
    // The same lists and role as <admin-app>'s other pages, so a save on one page shows on the others.
    page.catalog = this.catalog;
    page.session = this.session;
    // A detached page's errors can't bubble up to <admin-app>, so pass them on.
    page.addEventListener("page-error", (/** @type {Event} */ event) => {
      if (!page.isConnected) this.showPageError(event);
    });
    page.reopenRoute = () => this.openRoute();
    return page;
  }

  /** @param {{ name: string, id?: string }} route */
  pageFor(route) {
    const page = this.routePage;
    if (!page?.shows(route)) return null;
    return this.state.hasToken || SHOWN_SIGNED_OUT.has(route.name)
      ? page
      : null;
  }

  /**
   * Draw the shell around the route's page. A page already on screen stays
   * in place, so a shell redraw keeps its typing and open dialogs.
   * @returns {void}
   */
  render(loading = false) {
    this.state.hasToken = hasAdminSession();
    const route = currentRoute();
    const page = loading ? null : this.pageFor(route);
    // Sign-in hides the page, and its open dialog may never answer, so stop waiting for it.
    if (!this.state.hasToken && this.shownPage && !page)
      this.leaveDestination = this.leavePrompt = undefined;
    this.shownPage = page;
    const capabilities = this.session.capabilities;
    const shell = `
        <header class="admin__header">
          <div class="site-title">
            <a class="brand" href="/sites" data-route>${escapeHtml(t("admin.brand"))}</a>
          </div>
          ${
            this.state.hasToken
              ? adminSettingsMenu(
                  capabilities.manageAdminUsers,
                  capabilities.createEntities,
                )
              : ""
          }
        </header>
        ${this.state.hasToken && insightsOn(this.session) ? modeNav(routeMode(route.name), (mode) => this.modes.href(mode)) : ""}
        ${localRoleEnabled(this.state.authConfig) ? `<div class="local-role-switch"><label for="local-role-switch">${escapeHtml(t("admin.localRole.label"))}</label><select id="local-role-switch"><option value="supervisor" ${getLocalRole() === "supervisor" ? "selected" : ""}>${escapeHtml(t("admin.localRole.supervisor"))}</option><option value="manager" ${getLocalRole() === "manager" ? "selected" : ""}>${escapeHtml(t("admin.localRole.manager"))}</option></select><p class="muted">${escapeHtml(t("admin.localRole.help"))}</p></div>` : ""}
        ${
          this.state.hasToken
            ? ""
            : `
              <section class="panel">
                <h2>Sign in</h2>
                <p class="muted">Use the City-managed admin sign-in to continue.</p>
                <button class="btn-primary" id="sign-in" type="button" ${this.state.authBusy ? "disabled" : ""}>
                  ${this.state.authBusy ? "Opening sign in..." : "Sign in with Cognito"}
                </button>
                ${
                  !this.state.authConfig.cognitoDomain ||
                  !this.state.authConfig.clientId
                    ? '<p class="error">Admin login is not configured for this environment.</p>'
                    : ""
                }
              </section>
            `
        }
        ${loading ? `<p role="status"><wa-spinner aria-hidden="true"></wa-spinner> ${escapeHtml(t("admin.status.loading"))}</p>` : ""}
        ${this.state.error ? `<p class="error">${escapeHtml(this.state.error)}</p>` : ""}
        ${this.routeReadFailed ? `<button class="btn-secondary" id="retry-page-load" type="button">${escapeHtml(t("common.retry"))}</button>` : ""}
        ${this.session.complianceDraft?.phase === "recovery" ? `<button id="retry-compliance-draft" class="btn-secondary" type="button">${escapeHtml(t("admin.compliance.resumeDraft"))}</button>` : ""}
        ${
          this.state.hasToken &&
          !loading &&
          route.name === "system-status" &&
          capabilities.manageAdminUsers
            ? `<system-status-view view="${escapeHtml(route.id)}"></system-status-view>`
            : ""
        }
        ${page ? "<template data-page-slot></template>" : ""}
      `;
    const main = this.querySelector("#main-content");
    if (page && main && page.parentElement === main) {
      const fresh = document.createElement("template");
      fresh.innerHTML = shell;
      const slot = /** @type {Element} */ (
        fresh.content.querySelector("template[data-page-slot]")
      );
      const after = [];
      for (let node = slot.nextSibling; node; node = node.nextSibling)
        after.push(node);
      slot.remove();
      for (const node of [...main.childNodes]) if (node !== page) node.remove();
      page.after(...after);
      page.before(fresh.content);
    } else {
      this.innerHTML = `
      <main class="admin" id="main-content" tabindex="-1">${shell}</main>
    `;
      if (page)
        this.querySelector("template[data-page-slot]")?.replaceWith(page);
    }
    this.lastRenderedPath = window.location.pathname + window.location.search;
    this.lastRenderLoading = loading;
  }
}

customElements.define("admin-app", AdminApp);
