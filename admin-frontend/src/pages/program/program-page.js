// The Program page: a Program record or the new Program form. It owns its
// state and reads, so its tests fake only the Program calls.
import { START_UP_LISTS } from "../../admin-catalog.js";
import { mixActions } from "../../mix-actions.js";
import { trackDirtyForm } from "../../form-state.js";
import { visibleRecords } from "../../record-navigation.js";
import { programEvents } from "./program.bindings.js";
import { programActions } from "./program.actions.js";
import { newProgramView, programView } from "./program.templates.js";

/**
 * @typedef {{ name: string, id?: string }} Route
 * @typedef {import("../../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../../admin-session.js").AdminSession} AdminSession
 * @typedef {AdminProgramPage & typeof programActions} ProgramPageElement
 */

const controlSelectors = Object.fromEntries(
  Object.entries(programEvents).map(([type, actions]) => [
    type,
    Object.keys(actions)
      .map((attribute) => `[${attribute}]`)
      .join(","),
  ]),
);

export class AdminProgramPage extends HTMLElement {
  constructor() {
    super();
    /** @type {{ program: any | null }} */
    this.state = { program: null };
    // Bumped by open() and leave(), so a read or save from an earlier visit stops there.
    this.visit = 0;
    // render() draws this route, not the URL, so a late redraw shows the right Program.
    /** @type {Route | null} */
    this.route = null;
    // Set before open() by <admin-app>'s createPage() or a test's mountPage().
    /** @type {AdminCatalog} */
    this.catalog = /** @type {any} */ (null);
    /** @type {AdminSession} */
    this.session = /** @type {any} */ (null);
    /** @type {Promise<boolean> | null} */
    this.leavePrompt = null;
    /** @type {((discard: boolean) => void) | null} */
    this.answerLeave = null;
  }

  connectedCallback() {
    for (const type of Object.keys(programEvents))
      this.addEventListener(type, this.controlEvent);
    this.render();
  }

  disconnectedCallback() {
    for (const type of Object.keys(programEvents))
      this.removeEventListener(type, this.controlEvent);
  }

  /** @param {Event} event */
  controlEvent = (event) => {
    const control =
      event.target instanceof Element
        ? event.target.closest(controlSelectors[event.type])
        : null;
    if (!(control instanceof HTMLElement) || !this.contains(control)) return;
    const actions = programEvents[event.type];
    const attribute = Object.keys(actions).find((name) =>
      control.hasAttribute(name),
    );
    if (attribute)
      actions[attribute](
        /** @type {ProgramPageElement} */ (this),
        control,
        event,
      );
  };

  /**
   * Load what the route shows; false when a newer open() or leave() came first.
   * @param {Route} route
   * @returns {Promise<boolean>}
   */
  async open(route) {
    const visit = ++this.visit;
    this.route = route;
    // The new Program form's provider picker reads catalog.providers.
    await this.catalog.ensure(START_UP_LISTS);
    if (visit !== this.visit) return false;
    if (route.name !== "program") return true;
    return /** @type {ProgramPageElement} */ (this).loadProgram(route.id || "");
  }

  /** <admin-app> calls this when the user goes to a route this page doesn't show. */
  leave() {
    this.visit++;
    this.route = null;
  }

  /** <admin-app> asks this before any route change, to warn before an edit is lost. */
  hasUnsavedChanges() {
    return Boolean(
      this.querySelector("[data-dirty-form][data-is-dirty='true']"),
    );
  }

  /**
   * Ask the user to keep or discard their edits; true when they discard.
   * @returns {Promise<boolean>}
   */
  confirmLeave() {
    if (this.leavePrompt) return this.leavePrompt;
    const dialog = this.querySelector("#site-unsaved-dialog");
    if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(true);
    this.leavePrompt = new Promise((resolve) => {
      this.answerLeave = (discard) => {
        this.leavePrompt = this.answerLeave = null;
        resolve(discard);
      };
      dialog.addEventListener(
        "close",
        () => this.answerLeave?.(dialog.returnValue === "discard"),
        { once: true },
      );
      dialog.returnValue = "";
      dialog.showModal();
    });
    return this.leavePrompt;
  }

  /** @param {Route} route */
  shows(route) {
    return (
      route.name === "program-new" ||
      Boolean(visibleRecords(this.state, route).program)
    );
  }

  focusOnOpen() {
    if (this.route?.name === "program")
      /** @type {ProgramPageElement} */ (this).focusProgram();
    else queueMicrotask(() => this.querySelector("h1")?.focus());
  }

  render() {
    // A redraw removes an open leave dialog without a close event, so answer Keep.
    this.answerLeave?.(false);
    const route = this.route;
    if (!route || !this.shows(route)) {
      this.innerHTML = "";
      return;
    }
    const canEdit = this.session.capabilities.createEntities === true;
    this.innerHTML =
      route.name === "program-new"
        ? newProgramView(this.catalog)
        : programView(this.state.program, canEdit);
    const form = this.querySelector("#program-details-form");
    if (form instanceof HTMLFormElement) trackDirtyForm(form);
    // Admins who can't create Sites shouldn't see a link to the new Site form.
    if (!canEdit)
      this.querySelectorAll('a[href="/sites/new"]').forEach((link) =>
        link.remove(),
      );
  }

  /** Show an error in <admin-app>'s error line, which sits outside this page. @param {Error} error */
  reportError(error) {
    this.dispatchEvent(
      new CustomEvent("page-error", { bubbles: true, detail: error }),
    );
  }
}

mixActions(AdminProgramPage, programActions);

customElements.define("admin-program-page", AdminProgramPage);
