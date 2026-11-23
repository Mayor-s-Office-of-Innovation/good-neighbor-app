// Setup code and device handlers, keyed by the control that starts each one.
import { asForm, dataAttr } from "../../dom.js";
import { canEditSite } from "../../site-permissions.js";

/**
 * @typedef {import("./site-page.js").SitePageElement} SitePageElement
 * @typedef {import("./record.bindings.js").SiteAction} SiteAction
 */

// Forms whose revoke-all request is still running, so a retype can't re-enable Submit.
const revokingForms = new WeakSet();

/** @param {SitePageElement} page @param {Element | null} form */
function syncRevokeAll(page, form) {
  const input = form?.querySelector("wa-input");
  const button = form?.querySelector("button");
  if (!input || !button) return;
  button.disabled =
    revokingForms.has(form) ||
    !canEditSite(page.state) ||
    input.value !== page.state.site?.name;
}

/** @type {Record<string, Record<string, SiteAction>>} */
export const siteAccessEvents = {
  submit: {
    "#setup-code-form": (page, form, event) => {
      event.preventDefault();
      page.issueSetupCode(asForm(form));
    },
    "#revoke-all-site-devices": async (page, form, event) => {
      event.preventDefault();
      const input = form.querySelector("wa-input");
      const button = form.querySelector("button");
      syncRevokeAll(page, form);
      if (button.disabled) return;
      revokingForms.add(form);
      input.disabled = true;
      syncRevokeAll(page, form);
      try {
        await page.revokeAllSiteDevices(form);
      } catch (err) {
        page.reportError(err);
      } finally {
        revokingForms.delete(form);
        input.disabled = !canEditSite(page.state);
        syncRevokeAll(page, form);
      }
    },
  },
  click: {
    "[data-issue-contact-code]": (page, button) =>
      page.issueSetupCodeForEmail(dataAttr(button, "data-issue-contact-code")),
    "[data-revoke-device]": (page, button) =>
      page
        .revokeDevice(dataAttr(button, "data-revoke-device"), button)
        .catch((err) => page.reportError(err)),
  },
  input: {
    "#revoke-all-site-devices wa-input": (page, input) =>
      syncRevokeAll(page, input.closest("#revoke-all-site-devices")),
  },
};

/**
 * Start the revoke-all button disabled until the Site name is typed.
 * @param {SitePageElement} page
 */
export function prepareSiteAccess(page) {
  syncRevokeAll(page, page.querySelector("#revoke-all-site-devices"));
}
