// Pieces the Provider, Program, Site and admin user pages all use, such as the
// discard-changes dialog and breadcrumbs, so they sit above the page folders.
import { t } from "../../../frontend/src/i18n/i18n.js";
import { escapeHtml } from "../dom.js";

export function discardChangesDialog() {
  return `<dialog id="site-unsaved-dialog" class="places-modal site-admin-discard-dialog" aria-labelledby="site-unsaved-title" aria-describedby="site-unsaved-copy">
    <form class="places-modal__card" method="dialog">
      <div class="places-modal__copy">
        <h2 class="places-modal__title" id="site-unsaved-title">${escapeHtml(t("siteAdmin.discard.title"))}</h2>
        <p class="places-modal__text" id="site-unsaved-copy">${escapeHtml(t("siteAdmin.discard.text"))}</p>
      </div>
      <div class="places-modal__actions">
        <button class="btn-outline" value="keep">${escapeHtml(t("common.keepEditing"))}</button>
        <button class="btn-danger" value="discard">${escapeHtml(t("common.discardChanges"))}</button>
      </div>
    </form>
  </dialog>`;
}

/**
 * Open the discard-changes dialog inside `page`. True when the user picks Discard;
 * false when they keep editing, or when the page drew no dialog to ask with.
 * @param {ParentNode} page
 * @returns {Promise<boolean>}
 */
export function confirmDiscardChanges(page) {
  const dialog = page.querySelector("#site-unsaved-dialog");
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(false);
  const asked = openPrompts.get(dialog);
  if (asked) return asked;
  const prompt = new Promise((resolve) => {
    // A redraw removes the dialog without a close event, so treat that as Keep editing.
    const removed = new MutationObserver(() => {
      if (!page.contains(dialog)) answer(false);
    });
    /** @param {boolean} discard */
    const answer = (discard) => {
      removed.disconnect();
      openPrompts.delete(dialog);
      resolve(discard);
    };
    removed.observe(page, { childList: true, subtree: true });
    dialog.addEventListener(
      "close",
      () => answer(dialog.returnValue === "discard"),
      { once: true },
    );
    dialog.returnValue = "";
    dialog.showModal();
  });
  openPrompts.set(dialog, prompt);
  return prompt;
}

// The open dialog's answer, so a second leave while it shows waits for the same choice.
/** @type {WeakMap<HTMLDialogElement, Promise<boolean>>} */
const openPrompts = new WeakMap();

/** @param {unknown} value */
export function shortOpaqueId(value) {
  const id = String(value || "");
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** @param {"site" | "program" | "provider" | "manager"} kind @param {any} record @param {any[]} programs @param {any[]} providers */
export function entityBreadcrumb(kind, record, programs = [], providers = []) {
  const program =
    kind === "site" || kind === "manager"
      ? programs.find(
          (item) =>
            item.programId ===
            (kind === "site" ? record.leadProgramId : record.programId),
        )
      : record;
  const providerId = record.providerId || program?.providerId;
  const providerName =
    record.providerName ||
    program?.providerName ||
    providers.find((item) => item.providerId === providerId)?.name;
  const parents = [];
  if (kind !== "provider" && providerId)
    parents.push({
      href: `/providers/${encodeURIComponent(providerId)}`,
      label: providerName || t("admin.breadcrumb.provider"),
    });
  const parentProgramId =
    kind === "site"
      ? record.leadProgramId
      : kind === "manager"
        ? record.programId
        : "";
  if (parentProgramId)
    parents.push({
      href: `/programs/${encodeURIComponent(parentProgramId)}`,
      label:
        program?.name || record.programName || t("admin.breadcrumb.program"),
    });
  const root =
    kind === "provider"
      ? "/providers"
      : kind === "program"
        ? "/programs"
        : kind === "manager"
          ? "/managers"
          : "/sites";
  return `<nav class="entity-breadcrumb" aria-label="${escapeHtml(t("admin.breadcrumb.label"))}"><ol>
    <li><a href="${root}" data-route>${escapeHtml(t("admin.breadcrumb.admin"))}</a></li>
    ${parents.map((parent) => `<li class="entity-breadcrumb__parent"><span aria-hidden="true">›</span><a href="${parent.href}" data-route>${escapeHtml(parent.label)}</a></li>`).join("")}
    <li><span aria-hidden="true">›</span><span aria-current="page">${escapeHtml(t(`admin.breadcrumb.${kind}`))}</span></li>
  </ol></nav>`;
}

export function phoneWithExtension(contact) {
  const phone = String(contact?.phone || "");
  const extension = String(contact?.phoneExtension || "");
  return extension ? `${phone} ext. ${extension}` : phone;
}

export function uniqueNamedOptions(items) {
  return [
    ...new Map(
      items.filter((item) => item?.name).map((item) => [item.name, item]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
