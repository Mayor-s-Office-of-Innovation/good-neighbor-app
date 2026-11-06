// AdminApp.bind() adds these again after each render() replaces the HTML.
import { asForm } from "../../dom.js";
import { formValue, showFormSaveError } from "../../form-state.js";
import { navigate } from "../../router.js";
import { siteSaveErrorMessage } from "./save-error-messages.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { withSaveFeedback } from "../../save-feedback.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindNewSiteFlow(app) {
  app
    .querySelector("#new-site-provider-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const providerId = formValue(
        new FormData(asForm(event.currentTarget)),
        "provider-id",
      );
      if (providerId)
        navigate(`/sites/new?providerId=${encodeURIComponent(providerId)}`);
    });
  app
    .querySelector("#new-site-program-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(asForm(event.currentTarget));
      navigate(
        `/sites/new?providerId=${encodeURIComponent(formValue(data, "provider-id"))}&programId=${encodeURIComponent(formValue(data, "program-id"))}`,
      );
    });
  app
    .querySelector("#new-site-record-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = asForm(event.currentTarget);
      void withSaveFeedback(form, () => app.createSiteFromFlow(form), {
        savingLabel: t("siteAdmin.edit.saving"),
        onError: (error) => {
          if (form.isConnected)
            showFormSaveError(form, siteSaveErrorMessage(error));
        },
      });
    });
  app.querySelectorAll(".new-record-form [required]").forEach((control) => {
    const sync = () => {
      control.toggleAttribute(
        "data-empty",
        !String(control.value || "").trim(),
      );
    };
    sync();
    control.addEventListener("input", sync);
    control.addEventListener("change", sync);
  });
}
