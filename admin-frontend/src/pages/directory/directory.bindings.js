// AdminApp.bind() adds these again after each render() replaces the HTML.
import { adminApi } from "../../services/admin-api.js";
import { asForm } from "../../dom.js";
import { bind311Batch } from "./site-311-batch.js";
import { debounce } from "../../debounce.js";
import { navigate } from "../../router.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindDirectorySearch(app) {
  const searchInput = app.querySelector("#directory-search-input");
  if (searchInput) {
    let composing = false;
    const search = async () => {
      app.directorySearchDebounce?.cancel();
      if (composing || !searchInput.isConnected) return;
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
      app.state.managerSearchFailed = false;
      app.renderDirectoryResults();
      if (value.trim()) void app.loadSearchManagers();
    };
    app.directorySearchDebounce = debounce(search, 300);
    searchInput.addEventListener("input", () => {
      if (!composing) app.directorySearchDebounce.schedule();
    });
    searchInput.addEventListener("compositionstart", () => {
      composing = true;
      app.directorySearchDebounce.cancel();
    });
    searchInput.addEventListener("compositionend", () => {
      composing = false;
      app.directorySearchDebounce.schedule();
    });
    app
      .querySelector("#directory-search")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        search();
      });
    app
      .querySelector("#clear-directory-search")
      ?.addEventListener("click", () => {
        searchInput.value = "";
        searchInput.focus();
        search();
      });
  }
}

/** @param {AdminAppElement} app */
export function bindDirectoryFilters(app) {
  bind311Batch(app, app.state, adminApi);
  app
    .querySelector("#site-directory-filters")
    ?.addEventListener("change", (event) => {
      const params = new URLSearchParams(window.location.search);
      const data = new FormData(asForm(event.currentTarget));
      for (const key of ["manager", "department", "system"]) {
        const value = String(data.get(key) || "");
        if (value || key === "manager") params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      navigate(`/sites${query ? `?${query}` : ""}`);
    });
  app
    .querySelector("#manager-directory-filters")
    ?.addEventListener("change", (event) => {
      const params = new URLSearchParams(window.location.search);
      const data = new FormData(asForm(event.currentTarget));
      for (const key of ["program", "site"]) {
        const value = String(data.get(key) || "");
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const query = params.toString();
      navigate(`/managers${query ? `?${query}` : ""}`);
    });
}
