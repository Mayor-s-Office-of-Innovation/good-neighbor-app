/** Keep email and screen issuance from replacing each other while a response is pending.
 * Lock the entity rather than a membership ID, which can change during legacy conversion.
 */
export function beginEnrollmentRequest(root, scope, id) {
  if (!id) return null;
  const pending = (root.enrollmentRequests ||= new Set());
  const key = `${scope}:${id}`;
  if (pending.has(key)) return null;
  pending.add(key);
  syncEnrollmentRequests(root);
  return () => {
    pending.delete(key);
    syncEnrollmentRequests(root);
  };
}

/** Preserve any independent disabled state, including read-only permissions. */
export function syncEnrollmentRequests(root) {
  const disabled = (root.enrollmentDisabled ||= new WeakMap());
  for (const button of root.querySelectorAll?.(
    "[data-show-enrollment-code], [data-issue-manager-grant], [data-issue-provider-manager-grant]",
  ) || []) {
    const scope =
      button.hasAttribute("data-issue-provider-manager-grant") ||
      button.dataset.enrollmentScope === "provider"
        ? "provider"
        : "site";
    const id =
      scope === "site"
        ? root.state.site?.siteId
        : root.state.provider?.providerId;
    if (root.enrollmentRequests?.has(`${scope}:${id}`)) {
      if (!disabled.has(button)) disabled.set(button, button.disabled);
      button.disabled = true;
    } else if (disabled.has(button)) {
      button.disabled = disabled.get(button);
      disabled.delete(button);
    }
  }
}
