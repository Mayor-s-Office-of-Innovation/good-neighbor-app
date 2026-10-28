import { t } from "../i18n/i18n.js";
import { escapeHtml, escapeAttr, html } from "../lib/html.js";
import { formatDateTime } from "../i18n/dates.js";
import { listManagerDeviceBindings } from "../services/api.js";

export async function refreshDevices(view) {
  const result = await listManagerDeviceBindings();
  if (!view.isConnected) return;
  view._bindings = result.bindings || [];
  view.querySelector(".site-access-list").innerHTML = view._bindings.length
    ? view._bindings
        .map((binding) => deviceRow(binding, view._canInviteManagers))
        .join("")
    : html`<p class="site-admin-empty">${escapeHtml(t("access.empty"))}</p>`;
}

/** @param {unknown} value */
function formatTimestamp(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "—";
  return formatDateTime(date, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** @param {Record<string, any>} binding */
export function deviceRow(binding, provider = false) {
  return html`<article class="site-access-device">
    <div>
      <h3>${escapeHtml(binding.label || t("access.device"))}</h3>
      <p>
        ${escapeHtml(t(`access.role.${binding.accessLevel}`))} ·
        ${escapeHtml(binding.status || "active")} ·
        ${escapeHtml(t("access.lastSeen"))}
        ${escapeHtml(formatTimestamp(binding.lastSeenAt))}
      </p>
    </div>
    ${binding.status === "active" &&
    (binding.accessLevel === "general" ||
      (provider &&
        binding.accessLevel === "manager" &&
        binding.authorityScope !== "provider"))
      ? html`<button
          class="btn-outline"
          type="button"
          data-revoke-team-device="${escapeAttr(binding.bindingId)}"
          data-revoke-team-device-label="${escapeAttr(
            binding.label || t("access.device"),
          )}"
        >
          ${escapeHtml(t("access.revoke"))}
        </button>`
      : ""}
    ${binding.sessions?.length
      ? html`<details class="site-access-sessions">
          <summary>${escapeHtml(t("access.sessions"))}</summary>
          <ul>
            ${binding.sessions
              .map(
                (session) =>
                  html`<li data-session-kind="${escapeAttr(session.kind)}">
                    <strong
                      >${escapeHtml(
                        t(
                          session.kind === "home_screen"
                            ? "access.session.homeScreen"
                            : "access.session.browser",
                        ),
                      )}</strong
                    >
                    <p>
                      ${escapeHtml(
                        t(
                          `access.session.status.${session.status === "signed_out" ? "signedOut" : session.status}`,
                        ),
                      )}
                      · ${escapeHtml(t("access.lastSeen"))}
                      ${escapeHtml(formatTimestamp(session.lastSeenAt))}
                    </p>
                  </li>`,
              )
              .join("")}
          </ul>
        </details>`
      : ""}
  </article>`;
}
