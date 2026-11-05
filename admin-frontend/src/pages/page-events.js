// Shared by the page elements in pages/, so a fix to how a page finds a control's
// action, or how it joins its catalog and session for templates, is made once.

/**
 * @typedef {import("../admin-catalog.js").AdminCatalog} AdminCatalog
 * @typedef {import("../admin-session.js").AdminSession} AdminSession
 * @typedef {HTMLElement & { state: object, catalog: AdminCatalog, session: AdminSession }} PageElement
 */

/**
 * Listen once per event type on the page, so a redraw can't drop or double a control's action.
 * @param {HTMLElement} page
 * @param {Record<string, Record<string, (page: any, control: HTMLElement, event: Event) => void>>} events
 *   actions keyed by event type, then control selector
 * @param {string[]} [captured] types that don't bubble, such as a dialog's close
 * @returns {() => void} removes the listeners
 */
export function listenForControls(page, events, captured = []) {
  /** @param {Event} event */
  const listener = (event) => {
    const actions = events[event.type];
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
 * What templates read as `state`: the page's own state, plus its session's and catalog's lists.
 * @param {PageElement} page
 * @param {Record<string, () => unknown>} [more] other getters, such as lists <admin-app> still holds
 * @returns {any}
 */
export function pageView(page, more = {}) {
  const view = Object.create(page.state);
  const shared = {
    role: () => page.session.role,
    capabilities: () => page.session.capabilities,
    profile: () => page.session.profile,
    providers: () => page.catalog.providers,
    programs: () => page.catalog.programs,
    oversightOptions: () => page.catalog.oversightOptions,
    programManagers: () => page.catalog.programManagers,
    sites: () => page.catalog.sites,
    managerDirectoryLoaded: () => page.catalog.managersLoaded,
    ...more,
  };
  for (const [name, get] of Object.entries(shared))
    Object.defineProperty(view, name, { get, enumerable: true });
  return view;
}
