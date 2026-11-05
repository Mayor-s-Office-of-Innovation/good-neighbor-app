// Directory actions, mixed into <admin-directory-page> so tests can mount it alone.
import { asForm } from "../../dom.js";
import { debounce } from "../../debounce.js";
import { sync311Batch } from "./site-311-batch.js";
import { navigate } from "../../router.js";
import { directoryView } from "./directory.templates.js";

export const directoryActions = {
  /** @returns {void} */
  renderDirectoryResults() {
    // A page that was left or taken off screen must not report a path as drawn.
    if (!this.route || !this.isConnected) return;
    const current = this.querySelector("#directory-results");
    if (!current) return this.render();
    const template = document.createElement("template");
    template.innerHTML = directoryView(this.view(), this.route);
    current.replaceChildren(
      ...template.content.querySelector("#directory-results").childNodes,
    );
    const clear = this.querySelector("#clear-directory-search");
    if (clear) clear.hidden = !new URLSearchParams(location.search).get("q");
    sync311Batch(this, this.view());
    this.applyCapabilities();
    this.pathRendered(location.pathname + location.search);
  },
  async loadSearchManagers() {
    if (this.managersLoaded()) return;
    const visit = this.visit;
    this.state.managerSearchFailed = false;
    let failed = false;
    // Every visit awaits the one GET people read, so a return visit still redraws.
    try {
      await this.loadManagers();
    } catch {
      failed = true;
    }
    // An earlier visit's failed read mustn't show an error on this visit.
    if (visit !== this.visit) return;
    this.state.managerSearchFailed = failed;
    const input = this.querySelector("#directory-search-input");
    if (
      !input ||
      (!new URLSearchParams(location.search).get("q")?.trim() &&
        this.route?.name !== "managers")
    )
      return;
    this.renderDirectoryResults();
  },
  /** Filter the loaded directory in place, so focus stays in the search box. */
  async searchDirectory() {
    this.directorySearchDebounce?.cancel();
    const searchInput = this.querySelector("#directory-search-input");
    if (this.composing || !searchInput?.isConnected) return;
    const value = String(searchInput.value || "");
    const params = new URLSearchParams(location.search);
    if ((params.get("q") || "") === value.trim()) return;
    if (value.trim()) params.set("q", value.trim());
    else params.delete("q");
    const query = params.toString();
    history.replaceState(
      {},
      "",
      `${location.pathname}${query ? `?${query}` : ""}`,
    );
    // Filtering uses the already-loaded directory. Avoid a route change,
    // which would move focus to the heading or reload manager data.
    this.state.managerSearchFailed = false;
    this.renderDirectoryResults();
    if (value.trim()) void this.loadSearchManagers();
  },
  scheduleSearch() {
    this.directorySearchDebounce ||= debounce(
      () => this.searchDirectory(),
      300,
    );
    this.directorySearchDebounce.schedule();
  },
  /** @param {HTMLFormElement} form */
  filterSites(form) {
    const params = new URLSearchParams(window.location.search);
    const data = new FormData(asForm(form));
    for (const key of ["manager", "department", "system"]) {
      const value = String(data.get(key) || "");
      if (value || key === "manager") params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    navigate(`/sites${query ? `?${query}` : ""}`);
  },
  /** @param {HTMLFormElement} form */
  filterManagers(form) {
    const params = new URLSearchParams(window.location.search);
    const data = new FormData(asForm(form));
    for (const key of ["program", "site"]) {
      const value = String(data.get(key) || "");
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    navigate(`/managers${query ? `?${query}` : ""}`);
  },
};
