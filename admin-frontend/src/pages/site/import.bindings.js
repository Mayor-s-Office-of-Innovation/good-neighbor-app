// AdminApp.bind() adds these again after each render() replaces the HTML.
import { adminErrorMessage } from "../../admin-error-messages.js";
import { asForm } from "../../dom.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindSiteImport(app) {
  app.querySelector("#site-import-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    app.previewSiteImport(asForm(e.currentTarget)).catch((err) => {
      app.state.importBusy = false;
      app.state.error =
        err.message === "invalid_file_size"
          ? t("admin.import.fileTooLarge")
          : adminErrorMessage(err, t);
      app.render();
    });
  });
  app
    .querySelector('input[name="site-import-file"]')
    ?.addEventListener("change", (event) => {
      const input = /** @type {HTMLInputElement} */ (event.currentTarget);
      const fileName = app.querySelector("#site-import-file-name");
      if (!fileName) return;
      fileName.textContent = input.files?.[0]?.name || "";
      fileName.toggleAttribute("hidden", !input.files?.length);
    });
  app.querySelector("#apply-site-import")?.addEventListener("click", () => {
    app.applySiteImport().catch((err) => {
      app.state.importBusy = false;
      app.state.importNotice = null;
      app.state.error = adminErrorMessage(err, t);
      app.render();
    });
  });
  app.querySelector("#dismiss-import-notice")?.addEventListener("click", () => {
    app.state.importNotice = null;
    app.render();
  });
  app.querySelector("#cancel-site-import")?.addEventListener("click", () => {
    app.cancelSiteImport();
  });
  app.querySelector("#show-import-help")?.addEventListener("click", () => {
    app.querySelector("#site-import-help-dialog")?.showModal();
  });
  app
    .querySelector("#download-import-conflicts")
    ?.addEventListener("click", () => {
      app.downloadImportConflicts().catch((err) => {
        app.state.error = err.message;
        app.render();
      });
    });
}
