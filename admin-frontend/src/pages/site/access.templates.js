// HTML for the Site's App access tab. siteSectionView in record.templates.js
// draws it when that tab is open.
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { escapeHtml, formatTimestamp } from "../../dom.js";
import { enrollmentCodePanel } from "../../enrollment-code-view.js";
import { shortOpaqueId } from "../shared.templates.js";
import { managerMembershipList } from "./manager.templates.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 */

/** @param {AdminState} state */
export function siteAccessView(state) {
  const revocableDevices = state.devices.filter(
    (device) => device.status !== "revoked",
  );
  return `<section class="subsection site-access" aria-label="App access">
    <h2>${escapeHtml(t("admin.enrollment.siteAccessTitle"))}</h2>
    <p class="muted">${escapeHtml(t("admin.enrollment.instructions"))}</p>
    ${managerMembershipList(state.managerMemberships, state.site.siteId)}
    ${enrollmentCodePanel(state, "site", state.site.siteId)}
    ${managerGrantList(state.managerGrants)}
    <h2>${escapeHtml(t("admin.enrollment.enrolledDevices"))}</h2>
    ${revocableDevices.length ? "" : '<p class="empty-state">No devices in use.</p>'}
    ${state.revocationMessage ? `<p class="success" role="status">${escapeHtml(state.revocationMessage)}</p>` : ""}
    <div class="device-list">${revocableDevices
      .map((device) => {
        const id = device.bindingId || device.deviceId;
        const label = device.label || shortOpaqueId(id);
        const attribution =
          device.managerEmail ||
          (device.enrolledByEmail
            ? t("admin.devices.enrolledBy", { email: device.enrolledByEmail })
            : t("admin.devices.emailUnavailable"));
        return `<div class="device-row"><div class="device-row__details"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(attribution)}</span><span>${escapeHtml(t("admin.devices.identifier", { id: shortOpaqueId(id) }))}</span><span>${escapeHtml(t("admin.devices.lastSeen", { date: formatTimestamp(device.lastSeenAt) }))}</span></div><button class="btn-icon device-remove" type="button" data-revoke-device="${escapeHtml(id)}" aria-label="${escapeHtml(t("admin.devices.removeFromSite", { name: label }))}" title="${escapeHtml(t("admin.devices.removeFromSite", { name: label }))}"><wa-icon name="trash" aria-hidden="true"></wa-icon></button></div>`;
      })
      .join("")}</div>
    <form id="revoke-all-site-devices" class="inline-form destructive-confirmation"><wa-input id="revoke-all-confirmation" name="confirmation" autocomplete="off"><span slot="label">Type <strong>${escapeHtml(state.site.name)}</strong> to revoke access for every device used on this site</span></wa-input><button class="btn-danger" type="submit" disabled>Revoke all devices at this Site</button></form>
  </section>`;
}

/** @param {any[]} grants */
function managerGrantList(grants) {
  if (!grants.length)
    return `<details class="table-disclosure site-enrollment-history"><summary>${escapeHtml(t("admin.enrollment.history", { count: 0 }))}</summary><p class="empty-state">No enrollment links issued.</p></details>`;
  const hasCopyableLink = grants.some((grant) => Boolean(grant.enrollmentUrl));
  return `<details class="table-disclosure site-enrollment-history"><summary>${escapeHtml(t("admin.enrollment.history", { count: grants.length }))}</summary><div class="table-wrap"><table><thead><tr><th>Recipient</th><th>${escapeHtml(t("admin.enrollment.type"))}</th><th>Issued</th><th>Expires</th><th>Status</th><th>${escapeHtml(t("admin.enrollment.delivery"))}</th><th>Security notice</th>${hasCopyableLink ? `<th>${escapeHtml(t("admin.enrollment.link"))}</th>` : ""}<th>Action</th></tr></thead><tbody>${grants
    .map(
      (grant) =>
        `<tr><td>${escapeHtml(grant.issuedTo)}</td><td>${escapeHtml(t(grant.deliveryMode === "code" ? "admin.enrollment.oneTimeCode" : "admin.enrollment.magicLink"))}</td><td>${escapeHtml(formatTimestamp(grant.createdAt))}</td><td>${escapeHtml(formatTimestamp(grant.expiresAt))}</td><td>${escapeHtml(grant.status)}</td><td>${escapeHtml(grant.deliveryChannel === "screen" ? t("admin.enrollment.screenIssued") : grant.deliveryStatus || "queued")}</td><td>${escapeHtml(grant.securityNotificationStatus || (grant.status === "redeemed" ? "pending" : "Not applicable"))}</td>${hasCopyableLink ? `<td>${grant.enrollmentUrl ? `<button class="btn-secondary enrollment-copy" type="button" data-copy-enrollment-url="${escapeHtml(grant.enrollmentUrl)}" aria-label="${escapeHtml(t("admin.enrollment.copyFor", { email: grant.issuedTo }))}">${escapeHtml(t("admin.enrollment.copy"))}</button><span class="visually-hidden" aria-live="polite" data-copy-status></span>` : "—"}</td>` : ""}<td>${grant.status === "pending" ? `<button class="btn-danger" type="button" data-cancel-manager-grant="${escapeHtml(grant.grantId)}">Cancel</button>` : "—"}</td></tr>`,
    )
    .join("")}</tbody></table></div></details>`;
}
