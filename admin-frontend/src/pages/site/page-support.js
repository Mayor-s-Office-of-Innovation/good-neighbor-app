// Event plumbing the Site and manager pages share.

/**
 * @typedef {(page: any, control: any, event: any) => void} PageAction
 * @typedef {Record<string, Record<string, PageAction>>} PageEvents
 */

/**
 * Join event maps by type. A selector in two maps throws, so none is lost.
 * @param {...PageEvents} maps
 * @returns {PageEvents}
 */
export function mergeEvents(...maps) {
  /** @type {PageEvents} */
  const merged = {};
  for (const map of maps)
    for (const [type, actions] of Object.entries(map))
      for (const [selector, action] of Object.entries(actions)) {
        merged[type] ||= {};
        if (merged[type][selector])
          throw new Error(`Two ${type} handlers for ${selector}`);
        merged[type][selector] = action;
      }
  return merged;
}

/** How the Site and manager pages talk to <admin-app>, which sits outside them. */
export const pageMessages = {
  /** Show an error in <admin-app>'s error line. @param {Error} error */
  reportError(error) {
    this.dispatchEvent(
      new CustomEvent("page-error", { bubbles: true, detail: error }),
    );
  },
  /** Empty <admin-app>'s error line, so an old error doesn't sit beside a new result. */
  clearError() {
    this.reportError(new Error(""));
  },
  /** Ask <admin-app> to show its button that reopens the session's compliance draft. */
  reportDraftRecovery() {
    this.dispatchEvent(new CustomEvent("draft-recovery", { bubbles: true }));
  },
  /** Tell <admin-app> which path is on screen, for its unsaved-changes check. @param {string} path */
  reportPath(path) {
    this.dispatchEvent(
      new CustomEvent("page-rendered", { bubbles: true, detail: path }),
    );
  },
};
