/** Capture only the requirement fields, before navigating away from the modal.
 * @param {HTMLFormElement} form
 * @param {string} siteId
 */
export function captureComplianceDraft(form, siteId) {
  return {
    siteId,
    phase: "profile",
    reasons: [...form.querySelectorAll("wa-checkbox[name='terms-reason']")]
      .filter((control) => /** @type {any} */ (control).checked)
      .map((control) => String(/** @type {any} */ (control).value)),
    fields: Object.fromEntries(
      ["terms-site-manager-id", "terms-expiry", "terms-checks-per-day"].map(
        (name) => [
          name,
          String(
            /** @type {any} */ (form.querySelector(`[name="${name}"]`))
              ?.value || "",
          ),
        ],
      ),
    ),
  };
}

/** @param {HTMLFormElement} form @param {ReturnType<typeof captureComplianceDraft>} draft */
export function restoreComplianceDraft(form, draft) {
  for (const control of form.querySelectorAll(
    "wa-checkbox[name='terms-reason']",
  )) {
    /** @type {any} */ (control).checked = draft.reasons.includes(
      String(/** @type {any} */ (control).value),
    );
  }
  for (const [name, value] of Object.entries(draft.fields)) {
    const control = /** @type {any} */ (form.querySelector(`[name="${name}"]`));
    if (control) control.value = value;
  }
  form.dispatchEvent(new Event("change", { bubbles: true }));
}

/** @param {ReturnType<typeof captureComplianceDraft> | null} draft @param {string} destination */
export function complianceDraftAfterNavigation(draft, destination) {
  if (!draft) return null;
  if (draft.phase === "profile" && destination === "/profile") return draft;
  const returnPath = `/sites/${encodeURIComponent(draft.siteId)}?section=compliance`;
  if (
    ["profile", "returning"].includes(draft.phase) &&
    destination === returnPath
  )
    return { ...draft, phase: "returning" };
  return null;
}
