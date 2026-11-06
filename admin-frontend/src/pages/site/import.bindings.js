// Site import actions, keyed by event type and control selector.
// <admin-site-import-page> listens once per event type, so a redraw can't drop or double a handler.
import { adminErrorMessage } from "../../admin-error-messages.js";
import { asForm } from "../../dom.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("./site-import-page.js").SiteImportPageElement} SiteImportPageElement
 * @typedef {(page: SiteImportPageElement, control: HTMLElement, event: Event) => void} SiteImportAction
 */

/** @type {Record<string, Record<string, SiteImportAction>>} */
export const siteImportEvents = {
  click: {
    "#apply-site-import": (page) => {
      page.applySiteImport().catch((err) => {
        page.state.importBusy = false;
        page.state.importNotice = null;
        page.reportError(new Error(adminErrorMessage(err, t)));
      });
    },
    "#dismiss-import-notice": (page) => {
      page.state.importNotice = null;
      page.render();
    },
    "#cancel-site-import": (page) => page.cancelSiteImport(),
    "#show-import-help": (page) =>
      page.querySelector("#site-import-help-dialog")?.showModal(),
    "#download-import-conflicts": (page) => {
      page.downloadImportConflicts().catch((err) => page.reportError(err));
    },
  },
  submit: {
    "#site-import-form": (page, form, event) => {
      event.preventDefault();
      page.previewSiteImport(asForm(form)).catch((err) => {
        page.state.importBusy = false;
        page.reportError(
          new Error(
            err.message === "invalid_file_size"
              ? t("admin.import.fileTooLarge")
              : adminErrorMessage(err, t),
          ),
        );
      });
    },
  },
  change: {
    'input[name="site-import-file"]': (page, input) => {
      const files = /** @type {HTMLInputElement} */ (input).files;
      const fileName = page.querySelector("#site-import-file-name");
      if (!fileName) return;
      fileName.textContent = files?.[0]?.name || "";
      fileName.toggleAttribute("hidden", !files?.length);
    },
  },
};
