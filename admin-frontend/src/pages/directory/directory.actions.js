// main.js adds these to AdminApp, so they can use this.state and render().
import { currentRoute } from "../../router.js";
import { bindDirectoryFilters } from "./directory.bindings.js";
import { directoryView } from "./directory.templates.js";

export const directoryActions = {
  /** @returns {void} */
  renderDirectoryResults() {
    const current = this.querySelector("#directory-results");
    if (!current) return this.render();
    const template = document.createElement("template");
    template.innerHTML = directoryView(this.state, currentRoute());
    current.replaceChildren(
      ...template.content.querySelector("#directory-results").childNodes,
    );
    const clear = this.querySelector("#clear-directory-search");
    if (clear) clear.hidden = !new URLSearchParams(location.search).get("q");
    bindDirectoryFilters(this);
    this.applyCapabilities();
    this.lastRenderedPath = location.pathname + location.search;
  },
};
