import { upsertRecord } from "./save-feedback.js";

/** @param {Record<string, any>[]} programs @param {string} providerId */
export function siteProviderPrograms(programs, providerId) {
  return programs.filter((program) => program.status !== "inactive");
}

/** Bind the inline program creation flow without rerendering unsaved site edits. */
export function bindSiteProgramCreation(
  root,
  state,
  api,
  saveWithFeedback,
  sync,
  actionFeedback,
) {
  const select = root.querySelector('wa-select[name="lead-program-id"]');
  const dialog = root.querySelector("#create-site-program-dialog");
  if (!select || !dialog) return;
  const form = dialog.querySelector("form");
  const name = form.querySelector('[name="program-name"]');
  const providerId = state.site.providerId;
  let previous = select.value || select.dataset.initialValue || "";
  select.addEventListener("change", () => {
    if (select.value !== "__create_program__") {
      previous = select.value;
      return;
    }
    select.value = previous;
    sync();
    form.reset();
    form.querySelector("[data-form-save-error]")?.remove();
    dialog.showModal();
    name.focus();
  });
  dialog.addEventListener("cancel", (event) => {
    if (form.dataset.saving === "true") event.preventDefault();
  });
  dialog.addEventListener("close", () => select.focus());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const feedback = actionFeedback("admin.toast.programCreated");
    void saveWithFeedback(form, async () => {
      try {
        const { program } = await api.createProgram({
          providerId,
          name: String(name.value || "").trim(),
        });
        feedback.success();
        state.programs = upsertRecord(state.programs, program, "programId");
        if (!select.isConnected) return;
        const option = document.createElement("wa-option");
        option.value = program.programId;
        option.textContent = program.name;
        select.insertBefore(
          option,
          select.querySelector("[data-create-program]"),
        );
        await select.updateComplete;
        select.value = program.programId;
        previous = program.programId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        dialog.close();
      } catch (error) {
        feedback.failure(error);
        throw error;
      }
    });
  });
}
