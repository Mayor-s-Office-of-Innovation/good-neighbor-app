import { t } from "../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "./dom.js";

import {
  create311Batch,
  stage311,
  save311Batch,
  review311Draft,
} from "./site-311-batch-state.js";
export { create311Batch } from "./site-311-batch-state.js";

export function batch311Header() {
  return `<p>${escapeHtml(t("admin.batch311.hint"))}</p><div id="site-311-batch"></div>`;
}

export function batch311Checkbox(state, site) {
  if (state.capabilities.createEntities !== true) return "";
  const batch = state.site311Batch;
  const enabled =
    batch?.drafts.get(site.siteId)?.enabled ??
    site.deliberate311ProductionEnabled !== false;
  return `<wa-checkbox data-site-311="${escapeHtml(site.siteId)}" ${enabled ? "checked" : ""} ${batch?.saving ? "disabled" : ""} aria-label="${escapeHtml(t("admin.batch311.siteLabel", { name: site.name || site.siteId }))}">${escapeHtml(t("admin.batch311.label"))}</wa-checkbox>`;
}

export function bind311Batch(root, state, api) {
  const header = root.querySelector("#site-311-batch");
  if (!header || state.capabilities.createEntities !== true) return;
  const batch = (state.site311Batch ||= create311Batch());
  const sync = () => {
    if (!header.isConnected) return;
    const drafts = [...batch.drafts.values()];
    header.innerHTML = `<div role="status">${batch.saved ? escapeHtml(t("admin.batch311.saved", { count: batch.saved })) : ""}</div>
      ${
        drafts.length
          ? `<div class="site-311-banner"><p role="status">${escapeHtml(t("admin.batch311.unsaved", { count: drafts.length }))}</p>
      <div class="row"><button type="button" class="btn-primary" data-save-311 ${batch.saving || drafts.every((d) => d.error === "review") ? "disabled" : ""}>${escapeHtml(t(batch.saving ? "siteAdmin.edit.saving" : "admin.batch311.save"))}</button>
      <button type="button" class="btn-outline" data-discard-311 ${batch.saving ? "disabled" : ""}>${escapeHtml(t("common.discardChanges"))}</button></div>
      ${drafts
        .filter((d) => d.error)
        .map(
          (draft) =>
            `<p class="error">${escapeHtml(t(draft.error === "review" ? "admin.batch311.conflict" : "admin.batch311.failed", { name: draft.name, current: t(draft.latest?.deliberate311ProductionEnabled === false ? "admin.sites.deliberate311.simulated" : "admin.sites.deliberate311.production"), desired: t(draft.enabled ? "admin.sites.deliberate311.production" : "admin.sites.deliberate311.simulated") }))} ${draft.error === "review" ? `<button type="button" class="btn-outline" data-review-311="${escapeHtml(draft.siteId)}" ${batch.saving ? "disabled" : ""}>${escapeHtml(t("admin.batch311.review"))}</button>` : ""}</p>`,
        )
        .join("")}</div>`
          : ""
      }`;
    root.querySelectorAll("[data-site-311]").forEach((checkbox) => {
      const site = state.sites.find(
        (s) => s.siteId === checkbox.getAttribute("data-site-311"),
      );
      checkbox.disabled = batch.saving;
      if (site)
        checkbox.checked =
          batch.drafts.get(site.siteId)?.enabled ??
          site.deliberate311ProductionEnabled !== false;
    });
  };
  batch.refresh = sync;
  header.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target || batch.saving) return;
    if (target.hasAttribute("data-discard-311")) {
      batch.drafts.clear();
      batch.saved = 0;
      sync();
      root.querySelector("[data-site-311]")?.focus();
    } else if (target.hasAttribute("data-review-311")) {
      review311Draft(batch, target.getAttribute("data-review-311"));
      sync();
      header.querySelector("[data-save-311]")?.focus();
    } else if (target.hasAttribute("data-save-311")) {
      await save311Batch(
        batch,
        api,
        (site) => {
          state.sites = state.sites.map((s) =>
            s.siteId === site.siteId ? { ...s, ...site } : s,
          );
        },
        () => batch.refresh?.(),
      );
      header
        .querySelector("[data-save-311]:not([disabled]), [data-review-311]")
        ?.focus();
      if (!batch.drafts.size) root.querySelector("[data-site-311]")?.focus();
    }
  });
  root.querySelectorAll("[data-site-311]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const site = state.sites.find(
        (s) => s.siteId === checkbox.getAttribute("data-site-311"),
      );
      if (site) stage311(batch, site, checkbox.checked);
      sync();
    });
  });
  sync();
}
