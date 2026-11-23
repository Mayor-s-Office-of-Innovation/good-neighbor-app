// <admin-users-page>: the admin users list, the invite form and My profile. It owns
// the admin users list and its messages, so its tests fake only those calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { adminApi } from "../../services/admin-api.js";
import { mixActions } from "../../mix-actions.js";
import { hasDirtyForm, syncDirtyForm } from "../../form-state.js";
import { navigate } from "../../router.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { bindAdminInvitationLookup } from "./admin-invitation-lookup.js";
import { listenForControls, pageView } from "../page-events.js";
import { confirmDiscardChanges } from "../shared.templates.js";
import { adminUserEvents } from "./admin-user.bindings.js";
import { adminUserActions } from "./admin-user.actions.js";
import {
  administratorView,
  myProfileView,
  newAdministratorView,
} from "./admin-user.templates.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {AdminUsersPage & typeof adminUserActions} AdminUsersPageElement
 */

const ROUTES = ["administrators", "administrator-new", "profile"];

export class AdminUsersPage extends HTMLElement {
  constructor() {
    super();
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    /** @type {{ adminUsers: any[], adminUserStatusFilter: string, adminUserMessage: string, adminUserDirectoryMode: string, profileMessage: string }} */
    this.state = {
      adminUsers: [],
      adminUserStatusFilter: "all",
      adminUserMessage: "",
      adminUserDirectoryMode: "",
      profileMessage: "",
    };
    // Bumped by open() and leave(), so a read or save from an earlier visit stops there.
    this.visit = 0;
    // render() draws this route, not the URL, so a late redraw shows the right page.
    /** @type {Route | null} */
    this.route = null;
    // Kept while <admin-app> lives, so going back from the invite form skips a reread.
    this.adminUsersLoaded = false;
    this.useCachedAdminUsers = false;
    this.leftRouteName = "";
    /** @type {(() => Promise<void>) | null} */
    this.ensureInvitationLookup = null;
    /** Set by <admin-app> to reload its current route; without it, the page reloads itself. @type {(() => Promise<void>) | null} */
    this.reopenRoute = null;
  }

  connectedCallback() {
    this.stopListening = listenForControls(this, adminUserEvents);
    this.render();
  }

  disconnectedCallback() {
    this.stopListening?.();
  }

  /**
   * Load what the route shows; false when a newer open() or leave() came first.
   * @param {Route} route
   * @returns {Promise<boolean>}
   */
  async open(route) {
    const visit = ++this.visit;
    // leave() clears the route first, so it keeps the name for this check.
    const from = this.route?.name ?? this.leftRouteName;
    this.leftRouteName = "";
    this.route = route;
    const left = () => visit !== this.visit;
    if (route.name === "profile") {
      this.useCachedAdminUsers = false;
      // Read together, so My profile waits for one round trip, not three.
      const [, options, result] = await Promise.all([
        // My profile lists a compliance manager's Sites, so read Sites too.
        this.catalog.ensure([...START_UP_LISTS, "sites"]),
        adminApi.listOversightOptions(),
        adminApi.getMyProfile(),
      ]);
      if (left()) return false;
      this.catalog.setOversightOptions(options);
      this.session.setProfile(result.profile);
      this.state.profileMessage = "";
      return true;
    }
    if (route.name !== "administrators") {
      this.catalog.setOversightOptions(await adminApi.listOversightOptions());
      if (left()) return false;
    }
    if (!this.session.capabilities.manageAdminUsers) {
      navigate("/sites", { replace: true });
      return false;
    }
    if (route.name === "administrator-new") {
      // Only a list the user just left is fresh enough to show again unread.
      this.useCachedAdminUsers =
        this.adminUsersLoaded && from === "administrators";
      return true;
    }
    if (!this.useCachedAdminUsers) {
      const result = await adminApi.listAdminUsers();
      if (left()) return false;
      this.state.adminUsers = result.users || [];
      this.state.adminUserDirectoryMode = result.directoryMode || "cognito";
      this.adminUsersLoaded = true;
    }
    this.useCachedAdminUsers = false;
    return true;
  }

  /** The session holds the compliance draft, since it outlives the Site page during a profile edit. */
  complianceDraft() {
    return this.session.complianceDraft;
  }

  /**
   * Called by <admin-app> on route changes and when it drops pages.
   * @param {Route} [next]
   */
  leave(next) {
    this.visit++;
    this.leftRouteName = this.route?.name || "";
    this.route = null;
    // Only going back from the invite form to the list reuses the loaded users.
    if (next?.name !== "administrators") this.useCachedAdminUsers = false;
  }

  /** <admin-app> asks this before any route change; an invite still sending counts too. */
  hasUnsavedChanges() {
    return this.isSaving() || hasDirtyForm(this);
  }

  /** An invite already sending can't be cancelled, so leaving waits until it ends. */
  isSaving() {
    return Boolean(this.querySelector("#admin-user-form[data-saving='true']"));
  }

  /** Ask in this page's own dialog whether to drop its edits; true when the user discards. */
  async confirmLeave() {
    return !this.isSaving() && (await confirmDiscardChanges(this));
  }

  /** @param {Route} route */
  shows(route) {
    return ROUTES.includes(route.name);
  }

  focusOnOpen() {
    // Clears the error line, so the invite form never opens under an old error.
    if (this.route?.name === "administrator-new")
      this.reportError(new Error(""));
    const heading = {
      administrators: "#administrators-title",
      "administrator-new": "#new-admin-user-title",
      profile: "#profile-title",
    }[this.route?.name || ""];
    if (heading) this.querySelector(heading)?.focus();
  }

  render() {
    const route = this.route;
    if (!route || !this.shows(route)) {
      this.innerHTML = "";
      return;
    }
    const view = pageView(this, {
      complianceProfileDraft: () => this.complianceDraft(),
    });
    this.innerHTML =
      route.name === "profile"
        ? myProfileView(/** @type {any} */ (view))
        : route.name === "administrator-new"
          ? newAdministratorView(/** @type {any} */ (view))
          : administratorView(this.state.adminUsers, /** @type {any} */ (view));
    const invitation = this.querySelector("#admin-user-form");
    this.ensureInvitationLookup =
      invitation instanceof HTMLFormElement
        ? bindAdminInvitationLookup(
            invitation,
            adminApi.lookupAdminInvitation,
            t,
          )
        : null;
    const form = this.querySelector("[data-dirty-form]");
    if (form instanceof HTMLFormElement) syncDirtyForm(form, true);
  }

  /** Show an error in <admin-app>'s error line, which sits outside this page. @param {Error} error */
  reportError(error) {
    this.dispatchEvent(
      new CustomEvent("page-error", { bubbles: true, detail: error }),
    );
  }
}

mixActions(AdminUsersPage, adminUserActions);

customElements.define("admin-users-page", AdminUsersPage);
