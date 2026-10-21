import { t } from "../../frontend/src/i18n/i18n.js";
import { loadProviderStaff } from "./provider-staff.js";

/** Bind the new-program staff picker without rerendering the program draft. */
export function bindNewProgramStaff(root, programs, api) {
  const form = root.querySelector("#program-form");
  if (!form) return;
  const provider = form.querySelector('[name="program-provider"]');
  const select = form.querySelector('[name="program-staff"]');
  const save = form.querySelector('[type="submit"]');
  const error = form.querySelector("[data-staff-error]");
  const retry = form.querySelector("[data-retry-staff]");
  const dialog = root.querySelector("#new-program-staff-dialog");
  const draftForm = dialog.querySelector("form");
  let generation = 0;
  let previous = "";
  let loadedProvider;
  const sync = () => {
    save.disabled =
      form.dataset.saving === "true" ||
      select.disabled ||
      !select.value ||
      select.value === "__create__";
  };
  form.addEventListener("save-feedback-end", sync);
  const option = (value, label) => {
    const item = document.createElement("wa-option");
    item.value = value;
    item.textContent = label;
    return item;
  };
  const load = async (retainDraft = false) => {
    const providerId = String(
      provider.value || provider.dataset.initialValue || "",
    );
    if (loadedProvider === providerId) return;
    loadedProvider = providerId;
    const current = ++generation;
    const draft = retainDraft
      ? select.querySelector("[data-staff-draft]")
      : null;
    const draftValue = draft && select.value === draft.value ? draft.value : "";
    select.value = "";
    previous = "";
    select.replaceChildren();
    select.disabled = true;
    error.textContent = "";
    retry.hidden = true;
    sync();
    if (!providerId) return;
    if (draft) select.append(draft);
    select.append(option("__create__", t("admin.programs.createStaff")));
    select.disabled = false;
    select.value = draftValue;
    previous = draftValue;
    sync();
    try {
      const people = await loadProviderStaff(providerId, programs, api);
      if (current !== generation || !form.isConnected) return;
      for (const { person, reference } of people) {
        select.insertBefore(
          option(
            encodeURIComponent(JSON.stringify({ existingStaff: reference })),
            `${person.firstName} ${person.lastName} (${person.email})`,
          ),
          select.lastElementChild,
        );
      }
      select.disabled = false;
      sync();
    } catch {
      if (current === generation) {
        loadedProvider = undefined;
        error.textContent = t("admin.programs.staffLoadError");
        retry.hidden = false;
      }
    }
  };
  provider.addEventListener("change", () => {
    delete provider.dataset.initialValue;
    void load();
  });
  void load();
  retry.addEventListener("click", () => {
    loadedProvider = undefined;
    void load(true);
  });
  select.addEventListener("change", () => {
    if (select.value === "__create__") {
      select.value = previous;
      draftForm.reset();
      dialog.showModal();
    } else previous = select.value;
    sync();
  });
  dialog
    .querySelector("[data-cancel-staff]")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    select.focus();
    sync();
  });
  draftForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!draftForm.reportValidity()) return;
    const values = new FormData(draftForm);
    const firstStaff = Object.fromEntries(
      ["firstName", "lastName", "email", "phone", "phoneExtension"].map(
        (key) => [key, String(values.get(key) || "").trim()],
      ),
    );
    const value = encodeURIComponent(JSON.stringify({ firstStaff }));
    select.querySelector("[data-staff-draft]")?.remove();
    const item = option(
      value,
      `${firstStaff.firstName} ${firstStaff.lastName} (${firstStaff.email})`,
    );
    item.dataset.staffDraft = "true";
    select.insertBefore(item, select.lastElementChild);
    await select.updateComplete;
    select.value = value;
    previous = value;
    dialog.close();
    sync();
  });
}
