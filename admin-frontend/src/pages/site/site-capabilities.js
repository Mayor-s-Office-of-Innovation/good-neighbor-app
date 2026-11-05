// Disable or remove the Site and manager controls the signed-in role can't use.
import { canEditSite, canEditSiteManager } from "../../site-permissions.js";

/**
 * @typedef {import("../../admin-types.js").AdminState} AdminState
 */

/**
 * Runs after each render, since the templates draw every control.
 * @param {ParentNode} root
 * @param {AdminState} state
 */
export function applySiteCapabilities(root, state) {
  const capabilities = state.capabilities;
  const editableSite = canEditSite(state);
  if (state.site && !editableSite) {
    root
      .querySelectorAll(
        '.site-page form input, .site-page form select, .site-page form textarea, .site-page form wa-input, .site-page form wa-select, .site-page form wa-textarea, .site-page form wa-checkbox, .site-page form wa-number-input, .site-page form button:not([data-close-dialog]):not([value="cancel"]):not([value="close"])',
      )
      .forEach((element) => {
        // Informational dialogs and their Close controls remain usable.
        if (!element.closest("#compliance-reasons-dialog"))
          /** @type {any} */ (element).disabled = true;
      });
    root
      .querySelectorAll(
        "[data-require-checks], [data-end-checks], [data-resend-letter], [data-issue-manager-grant], [data-show-enrollment-code], [data-cancel-manager-grant], [data-revoke-device], [data-remove-manager-membership], [data-remove-site-manager], [data-edit-manager-membership]",
      )
      .forEach((element) => {
        /** @type {any} */ (element).disabled = true;
      });
  }
  if (state.siteManager && !canEditSiteManager(state)) {
    root
      .querySelectorAll(
        "#site-manager-record-form input, #site-manager-record-form wa-input, #site-manager-record-form wa-select, #site-manager-record-form wa-checkbox, #site-manager-record-form button, #revoke-manager-devices input, #revoke-manager-devices wa-input, #revoke-manager-devices button",
      )
      .forEach((element) => {
        /** @type {any} */ (element).disabled = true;
      });
  }
  if (capabilities.createEntities) return;
  root
    .querySelectorAll(
      'a[href="/sites/new"], a[href^="/providers/new"], a[href^="/programs/new"], a[href="/managers/new"], a[href="/sites/import"], [data-deactivate-provider], [data-deactivate-site], [data-remove-site-manager], [data-save-lead-program], #provider-program-form, #new-city-program-manager-dialog',
    )
    .forEach((element) => element.remove());
  if (!editableSite)
    root
      .querySelectorAll(
        "[data-remove-manager-membership], [data-remove-site-manager], #manager-membership-form",
      )
      .forEach((element) => element.remove());
  const leadProvider = root.querySelector('[name="lead-provider-id"]');
  if (leadProvider) /** @type {any} */ (leadProvider).disabled = true;
  const leadProgram = root.querySelector('[name="lead-program-id"]');
  if (leadProgram) /** @type {any} */ (leadProgram).disabled = true;
}
