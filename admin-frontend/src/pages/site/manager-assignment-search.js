import { debounce } from "../../debounce.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/** Bind a local search without replacing the input or moving focus while typing. */
export function bindManagerAssignmentSearch(form) {
  if (!form) return () => {};
  const input = form.querySelector("[data-manager-search]");
  const selected = form.querySelector('[name="manager-user-id"]');
  const results = form.querySelector("[data-manager-search-results]");
  const status = form.querySelector("[data-manager-search-status]");
  const actions = form.querySelector("[data-manager-membership-actions]");
  const options = [...results.querySelectorAll("[data-manager-option]")];
  let composing = false;
  const search = debounce(() => {
    if (!form.isConnected) return;
    const words = String(input.value || "")
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    let count = 0;
    options.forEach((button) => {
      const match =
        words.length &&
        words.every((word) => button.dataset.managerSearchText.includes(word));
      button.closest("li").hidden = !match || count >= 20;
      button.disabled = false;
      if (match) count++;
    });
    results.hidden = !words.length || !count;
    status.textContent = !words.length
      ? ""
      : count > 20
        ? t("admin.siteManagers.searchMore")
        : count
          ? t("admin.siteManagers.searchCount", { count })
          : t("admin.siteManagers.searchNone");
  }, 250);
  const resetSelection = () => {
    selected.value = "";
    actions.hidden = true;
    options.forEach((button) => {
      button.disabled = true;
    });
    if (!composing) search.schedule();
  };
  input.addEventListener("input", resetSelection);
  input.addEventListener("compositionstart", () => {
    composing = true;
    search.cancel();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    resetSelection();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
    if (event.key === "ArrowDown" && !results.hidden) {
      const first = options.find(
        (button) => !button.closest("li").hidden && !button.disabled,
      );
      if (first) {
        event.preventDefault();
        first.focus();
      }
    }
    if (event.key === "Escape") {
      search.cancel();
      results.hidden = true;
      status.textContent = "";
    }
  });
  options.forEach((button) =>
    button.addEventListener("click", () => {
      search.cancel();
      selected.value = button.dataset.managerOption;
      input.value = button.textContent.trim();
      results.hidden = true;
      status.textContent = "";
      actions.hidden = false;
      actions.querySelector('[type="submit"]').focus();
    }),
  );
  form
    .querySelector("[data-cancel-manager-assignment]")
    .addEventListener("click", () => {
      input.value = "";
      resetSelection();
      search.cancel();
      results.hidden = true;
      status.textContent = "";
      input.focus();
    });
  return search.cancel;
}
