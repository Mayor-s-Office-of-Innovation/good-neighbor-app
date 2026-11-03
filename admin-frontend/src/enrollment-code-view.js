import { t } from "../../frontend/src/i18n/i18n.js";
import { formatTimestamp, escapeHtml } from "./dom.js";

/** Secrets belong only to this view instance, never to cached entity records. */
export function clearEnrollmentCodeView(state) {
  const view = state.enrollmentCodeView;
  if (view) {
    clearTimeout(view.timer);
    view.codes.clear();
  }
  state.enrollmentCodeView = undefined;
}

export function enrollmentCodePanel(state, scope, id) {
  const view = state.enrollmentCodeView;
  if (!view) return "";
  const grants =
    scope === "site" ? state.managerGrants : state.providerManagerGrants;
  const visible = [...view.codes.values()].filter((entry) => {
    const grant = grants.find((g) => g.grantId === entry.grant.grantId);
    if (
      Date.parse(entry.grant.expiresAt) <= Date.now() ||
      (grant && grant.status !== "pending")
    ) {
      view.codes.delete(entry.grant.grantId);
      return false;
    }
    return entry.scope === scope && entry.id === id;
  });
  return visible
    .map(
      ({
        grant,
        code,
      }) => `<section class="subsection" data-enrollment-code="${escapeHtml(grant.grantId)}" data-code-expires="${escapeHtml(grant.expiresAt)}" aria-label="${escapeHtml(t("admin.enrollment.screenTitle"))}" tabindex="-1">
    <h3>${escapeHtml(t("admin.enrollment.screenFor", { email: grant.issuedTo }))}</h3>
    <p><strong class="enrollment-screen-code">${escapeHtml(code)}</strong></p>
    <p>${escapeHtml(t("admin.enrollment.screenExpiry", { date: formatTimestamp(grant.expiresAt) }))}</p>
    <p>${escapeHtml(t("admin.enrollment.screenHint"))}</p>
  </section>`,
    )
    .join("");
}

/** Remove expired secrets even when the administrator leaves this view open. */
export function bindEnrollmentCodeExpiry(root, state) {
  const view = state.enrollmentCodeView;
  if (!view) return;
  clearTimeout(view.timer);
  const expiries = [...view.codes.values()].map((entry) =>
    Date.parse(entry.grant.expiresAt),
  );
  if (!expiries.length) return;
  view.timer = setTimeout(
    () => {
      if (state.enrollmentCodeView !== view) return;
      for (const [id, entry] of view.codes) {
        if (Date.parse(entry.grant.expiresAt) <= Date.now())
          view.codes.delete(id);
      }
      root.querySelectorAll("[data-enrollment-code]").forEach((node) => {
        if (!view.codes.has(node.getAttribute("data-enrollment-code")))
          node.remove();
      });
      bindEnrollmentCodeExpiry(root, state);
    },
    Math.max(0, Math.min(...expiries) - Date.now()),
  );
}
