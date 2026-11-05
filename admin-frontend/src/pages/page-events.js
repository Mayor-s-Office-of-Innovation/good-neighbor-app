// Shared by the page elements in pages/, so a fix to how a page finds a control's
// action, or how it joins its catalog and session for templates, is made once.

/**
 * @typedef {import("../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../admin-session.js").AdminSession} AdminSession
 * @typedef {import("../admin-types.js").AdminState} AdminState
 * @typedef {HTMLElement & { state: object, catalog: AdminCatalog, session: AdminSession }} PageElement
 */

/**
 * Listen once per event type on the page, so a redraw can't drop or double a control's action.
 * @param {HTMLElement} page
 * @param {Record<string, Record<string, (page: any, control: HTMLElement, event: Event) => void>>} events
 *   actions keyed by event type, then control selector
 * @param {string[]} [captured] types that don't bubble, such as a dialog's close
 * @param {boolean} [every] run each matching control's action, innermost first, for pages whose controls nest
 * @returns {() => void} removes the listeners
 */
export function listenForControls(page, events, captured = [], every = false) {
  /** @param {Event} event */
  const listener = (event) => {
    const actions = events[event.type];
    if (every) {
      for (
        let node = event.target instanceof Element ? event.target : null;
        node && node !== page && page.contains(node);
        node = event.bubbles ? node.parentElement : null
      )
        for (const [selector, action] of Object.entries(actions))
          if (node.matches(selector)) action(page, node, event);
      return;
    }
    const control =
      event.target instanceof Element
        ? event.target.closest(Object.keys(actions).join(","))
        : null;
    if (!(control instanceof HTMLElement) || !page.contains(control)) return;
    const selector = Object.keys(actions).find((name) => control.matches(name));
    if (selector) actions[selector](page, control, event);
  };
  const types = Object.keys(events);
  for (const type of types)
    page.addEventListener(type, listener, captured.includes(type));
  return () => {
    for (const type of types)
      page.removeEventListener(type, listener, captured.includes(type));
  };
}

/**
 * Add the session's and catalog's lists to `target` as read-only getters.
 * @param {object} target
 * @param {{ catalog: AdminCatalog, session: AdminSession }} page
 * @param {Record<string, () => unknown>} more
 */
function addSharedLists(target, page, more) {
  const shared = {
    role: () => page.session.role,
    capabilities: () => page.session.capabilities,
    profile: () => page.session.profile,
    providers: () => page.catalog.providers,
    programs: () => page.catalog.programs,
    oversightOptions: () => page.catalog.oversightOptions,
    programManagers: () => page.catalog.programManagers,
    sites: () => page.catalog.sites,
    siteManagers: () => page.catalog.managers,
    managerDirectoryLoaded: () => page.catalog.managersLoaded,
    ...more,
  };
  for (const [name, get] of Object.entries(shared))
    Object.defineProperty(target, name, { get, enumerable: true });
  return target;
}

/**
 * What templates read as `state`: the page's own state, plus its session's and catalog's lists.
 * @param {PageElement} page
 * @param {Record<string, () => unknown>} [more] other getters, such as lists <admin-app> still holds
 * @returns {any}
 */
export function pageView(page, more = {}) {
  return addSharedLists(Object.create(page.state), page, more);
}

/**
 * The page's own fields with the same lists added, for pages whose actions
 * also read role and lists from `state`.
 * @param {{ catalog: AdminCatalog, session: AdminSession }} page
 * @param {Record<string, any>} fields
 * @returns {AdminState}
 */
export function pageState(page, fields) {
  return /** @type {AdminState} */ (addSharedLists(fields, page, {}));
}
