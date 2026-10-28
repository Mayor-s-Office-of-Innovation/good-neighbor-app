import { t } from "../i18n/i18n.js";
import { escapeAttr, escapeHtml, html } from "../lib/html.js";
import { formatAdminPhone } from "./site-admin.validation.js";

/** @param {Record<string, any>} site */
export function peopleSections(site) {
  return html`<section class="site-admin-section" data-site-managers>
      <div class="site-admin-section-heading">
        <h2>${escapeHtml(t("siteAdmin.managers.title"))}</h2>
        ${editButton(site.siteManagers?.[0])}
      </div>
      ${people(site.siteManagers || [], true)}
      <p class="site-admin-empty">
        ${escapeHtml(t("siteAdmin.managers.help"))}
      </p>
    </section>
    <section class="site-admin-section" data-city-managers>
      <h2>${escapeHtml(t("siteAdmin.cityManagers.title"))}</h2>
      ${people(site.cityProgramManagers || [], false)}
    </section>`;
}

/** @param {Record<string, any>[]} profiles @param {boolean} editable */
function people(profiles, editable) {
  if (!profiles.length)
    return html`<div
      class="site-admin-card site-admin-card--prose site-admin-empty"
    >
      ${escapeHtml(t("siteAdmin.managers.empty"))}
    </div>`;
  return profiles
    .map((profile, index) => {
      const phone = profile.phone
        ? html`<a
            href="tel:${escapeAttr(
              profile.phone.replace(/[^+\d]/g, "") +
                (profile.phoneExtension
                  ? `;ext=${profile.phoneExtension.replace(/\D/g, "")}`
                  : ""),
            )}"
            >${escapeHtml(
              formatAdminPhone(profile.phone),
            )}${profile.phoneExtension
              ? html` ${escapeHtml(
                  t("siteAdmin.phoneExtension", {
                    extension: profile.phoneExtension,
                  }),
                )}`
              : ""}</a
          >`
        : "—";
      const rows = [
        [t("siteAdmin.contact.name"), escapeHtml(profile.name || "—")],
        ...(!editable
          ? [
              [
                t("siteAdmin.oversight.department"),
                escapeHtml(profile.department || "—"),
              ],
            ]
          : []),
        [
          t("siteAdmin.field.email"),
          profile.email
            ? html`<a
                href="mailto:${escapeAttr(encodeURIComponent(profile.email))}"
                >${escapeHtml(profile.email)}</a
              >`
            : "—",
        ],
        [t("siteAdmin.field.phone"), phone],
      ];
      return html`<div class="site-admin-person">
        ${editable && index > 0
          ? html`<div
              class="site-admin-section-heading site-admin-person-actions"
            >
              ${editButton(profile)}
            </div>`
          : ""}
        <dl class="site-admin-card site-admin-rows">
          ${rows
            .map(
              ([label, value]) =>
                html`<div>
                  <dt>${escapeHtml(label)}</dt>
                  <dd>${value}</dd>
                </div>`,
            )
            .join("")}
        </dl>
      </div>`;
    })
    .join("");
}

/** @param {Record<string, any> | undefined} profile */
function editButton(profile) {
  return profile?.canEditPhone
    ? html`<button
        type="button"
        data-edit-section="manager/${escapeAttr(
          encodeURIComponent(profile.personId),
        )}"
      >
        <wa-icon name="pen" aria-hidden="true"></wa-icon>${escapeHtml(
          t("common.edit"),
        )}
      </button>`
    : "";
}
