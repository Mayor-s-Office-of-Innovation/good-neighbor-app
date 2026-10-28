import { t } from "../i18n/i18n.js";
import { escapeHtml, html } from "../lib/html.js";
import { getCurrentStaffEnrollmentGrant } from "../services/api.js";
import { formatCountdown } from "./site-admin.validation.js";
import { deviceRow } from "./site-access-devices.js";

/** @param {any} view */
export async function refreshGrants(view) {
  if (view._refreshing || document.visibilityState === "hidden") return;
  view._refreshing = true;
  const checked = new Set(view._grants.map((grant) => grant.grantId));
  try {
    const current = await getCurrentStaffEnrollmentGrant();
    if (!view.isConnected) return;
    await reconcileAccess(view, current);
    const pending = new Set(
      (current.grants || [])
        .filter((grant) => grant.status === "pending")
        .map((grant) => grant.grantId),
    );
    if ([...checked].some((id) => !pending.has(id)))
      await view._deviceView.refreshDevices(view);
    syncAccess(view);
    view._grants = view._grants.filter(
      (grant) =>
        (!checked.has(grant.grantId) || pending.has(grant.grantId)) &&
        Date.parse(grant.expiresAt) > Date.now(),
    );
    view.querySelectorAll("[data-grant-id]").forEach((card) => {
      const grant = view._grants.find(
        (item) => item.grantId === card.getAttribute("data-grant-id"),
      );
      if (!grant) card.remove();
      else
        card.querySelector("[data-grant-countdown]").textContent =
          formatCountdown(Date.parse(grant.expiresAt) - Date.now());
    });
  } catch (failure) {
    if ([401, 403].includes(failure?.status))
      await reconcileAccess(view, {
        canInviteManagers: false,
        canManageAccess: false,
      });
    /* Keep links until their status can be confirmed. */
  } finally {
    view._refreshing = false;
  }
}

/** @param {any} view @param {any} current */
export async function reconcileAccess(view, current) {
  if (!view.isConnected) return;
  const provider = current.canInviteManagers === true;
  const allowed = current.canManageAccess !== false;
  if (provider === view._canInviteManagers && allowed === view._canManageAccess)
    return;
  view._canInviteManagers = provider;
  view._canManageAccess = allowed;
  if (provider && !view._invitationControls) {
    view._invitationControls = await import("./site-access-roles.js");
    if (!view.isConnected) return;
    const input = view.querySelector("#staff-device-label");
    const label = input?.value;
    view._render();
    view.querySelector("#staff-device-label").value = label || "";
  }
  syncAccess(view);
  view.querySelector(".site-access-list").innerHTML = view._bindings.length
    ? view._bindings
        .map((binding) => deviceRow(binding, provider && allowed))
        .join("")
    : html`<p class="site-admin-empty">${escapeHtml(t("access.empty"))}</p>`;
  syncAccess(view);
}

/** @param {any} view */
export function syncAccess(view) {
  if (view._canManageAccess !== false) {
    view
      .querySelectorAll(
        "#staff-grant-form button, #staff-grant-form wa-input, #staff-grant-form wa-radio, [data-revoke-team-device], [data-confirm-device-revoke]",
      )
      .forEach((control) => (control.disabled = false));
    view.querySelector('#staff-grant-form button[type="submit"]').disabled =
      Boolean(view._creatingInvitation);
  }
  view._invitationControls?.syncInvitation(view);
  const role = view.querySelector("#invitation-role");
  if (role) {
    role.querySelector('[value="manager"]').disabled = !view._canInviteManagers;
    if (role.value === "manager" && !view._canInviteManagers)
      view.querySelector('#staff-grant-form button[type="submit"]').disabled =
        true;
  }
  if (view._canManageAccess === false) {
    view
      .querySelectorAll(
        "#staff-grant-form button, #staff-grant-form wa-input, #staff-grant-form wa-radio, [data-revoke-team-device], [data-confirm-device-revoke]",
      )
      .forEach((control) => (control.disabled = true));
  }
}

/** @param {any} view @param {any} failure */
export async function invitationError(view, failure) {
  if ([401, 403].includes(failure?.status))
    await reconcileAccess(view, {
      canInviteManagers: false,
      canManageAccess: false,
    });
  return failure?.body?.error === "manager_email_already_assigned"
    ? "access.duplicateEmail"
    : "access.createError";
}

/** @param {any} view */
export function observeAccess(view) {
  const refresh = () => void refreshGrants(view);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

/** @param {{ enrollmentUrl: string }} grant */
export async function shareGrant(grant) {
  const text = t("access.shareMessage");
  if (navigator.share) {
    try {
      await navigator.share({
        title: t("access.title"),
        text,
        url: grant.enrollmentUrl,
      });
    } catch {
      /* Dismissing the share sheet keeps the link available. */
    }
  } else
    await navigator.clipboard.writeText(`${text}\n\n${grant.enrollmentUrl}`);
}
