// Directory actions, keyed by event type and control selector.
// <admin-directory-page> listens once per event type, so a redraw can't drop or double a handler.
import { adminApi } from "../../services/admin-api.js";
import { asForm } from "../../dom.js";
import { change311Batch, click311Batch } from "./site-311-batch.js";

/**
 * @typedef {import("./directory-page.js").DirectoryPageElement} DirectoryPageElement
 * @typedef {(page: DirectoryPageElement, control: HTMLElement, event: Event) => void} DirectoryAction
 */

/** @param {DirectoryPageElement} page @param {HTMLElement} button */
const click311 = (page, button) =>
  void click311Batch(page, page.view(), adminApi, page.catalog, button);

/** @type {Record<string, Record<string, DirectoryAction>>} */
export const directoryEvents = {
  click: {
    "#clear-directory-search": (page) => {
      const input = /** @type {any} */ (
        page.querySelector("#directory-search-input")
      );
      input.value = "";
      input.focus();
      void page.searchDirectory();
    },
    "[data-save-311]": click311,
    "[data-discard-311]": click311,
    "[data-review-311]": click311,
  },
  submit: {
    "#directory-search": (page, form, event) => {
      event.preventDefault();
      void page.searchDirectory();
    },
  },
  input: {
    "#directory-search-input": (page) => {
      if (!page.composing) page.scheduleSearch();
    },
  },
  compositionstart: {
    "#directory-search-input": (page) => {
      page.composing = true;
      page.directorySearchDebounce?.cancel();
    },
  },
  compositionend: {
    "#directory-search-input": (page) => {
      page.composing = false;
      page.scheduleSearch();
    },
  },
  change: {
    "#site-directory-filters": (page, form) => page.filterSites(asForm(form)),
    "#manager-directory-filters": (page, form) =>
      page.filterManagers(asForm(form)),
    "[data-site-311]": (page, checkbox) =>
      change311Batch(page.view(), /** @type {any} */ (checkbox)),
  },
};
