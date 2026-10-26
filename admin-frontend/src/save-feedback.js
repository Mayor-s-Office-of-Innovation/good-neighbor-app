/** Keep drafts intact, announce progress, and suppress repeat submissions. */
export async function withSaveFeedback(form, save, { savingLabel, onError }) {
  if (form.dataset.saving === "true") return false;
  form.dataset.saving = "true";
  form.setAttribute("aria-busy", "true");
  const buttons = [
    ...form.querySelectorAll('button[type="submit"], button[data-save-button]'),
  ];
  const cancel = form.querySelector("[data-close-dialog], [data-save-cancel]");
  const cancelDisabled = cancel?.disabled;
  if (cancel) cancel.disabled = true;
  const previous = buttons.map((button) => ({
    button,
    text: button.textContent,
    disabled: button.disabled,
  }));
  for (const { button } of previous) {
    button.disabled = true;
    button.textContent = savingLabel;
  }
  const status = document.createElement("span");
  status.className = "muted";
  status.setAttribute("role", "status");
  status.textContent = savingLabel;
  form.append(status);
  form.querySelector("[data-form-save-error]")?.remove();
  try {
    return await save();
  } catch (error) {
    onError(error);
    return false;
  } finally {
    delete form.dataset.saving;
    form.removeAttribute("aria-busy");
    status.remove();
    if (cancel) cancel.disabled = cancelDisabled;
    for (const { button, text, disabled } of previous) {
      button.textContent = text;
      button.disabled = disabled;
    }
    form.dispatchEvent(new Event("save-feedback-end"));
  }
}

/** Merge a confirmed response without replacing unrelated cached records. */
export function upsertRecord(records, record, key) {
  const index = records.findIndex((item) => item[key] === record[key]);
  if (index < 0) return [...records, record];
  return records.map((item, i) =>
    i === index ? { ...item, ...record } : item,
  );
}
