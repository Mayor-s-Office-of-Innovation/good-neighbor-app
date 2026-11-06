// New Site flow actions, keyed by event type and control selector.
// <admin-new-site-page> listens once per event type, so a redraw can't drop or double a handler.
import { asForm } from "../../dom.js";
import { formValue, showFormSaveError } from "../../form-state.js";
import { addExtension, removeExtension } from "../../phone-extension.js";
import { navigate } from "../../router.js";
import { siteSaveErrorMessage } from "./save-error-messages.js";
import { t } from "../../../../frontend/src/i18n/i18n.js";
import { withSaveFeedback } from "../../save-feedback.js";

/**
 * @typedef {import("./new-site-page.js").NewSitePageElement} NewSitePageElement
 * @typedef {(page: NewSitePageElement, control: HTMLElement, event: Event) => void} NewSiteAction
 */

/** @param {NewSitePageElement} page @param {HTMLElement} control */
const markEmpty = (page, control) =>
  control.toggleAttribute(
    "data-empty",
    !String(/** @type {any} */ (control).value || "").trim(),
  );

/** @type {Record<string, Record<string, NewSiteAction>>} */
export const newSiteEvents = {
  click: {
    "[data-add-extension]": (page, button) => addExtension(button),
    "[data-remove-extension]": (page, button) => removeExtension(button),
  },
  submit: {
    "#new-site-provider-form": (page, form, event) => {
      event.preventDefault();
      const providerId = formValue(new FormData(asForm(form)), "provider-id");
      if (providerId)
        navigate(`/sites/new?providerId=${encodeURIComponent(providerId)}`);
    },
    "#new-site-program-form": (page, form, event) => {
      event.preventDefault();
      const data = new FormData(asForm(form));
      navigate(
        `/sites/new?providerId=${encodeURIComponent(formValue(data, "provider-id"))}&programId=${encodeURIComponent(formValue(data, "program-id"))}`,
      );
    },
    "#new-site-record-form": (page, control, event) => {
      event.preventDefault();
      const form = asForm(control);
      void withSaveFeedback(form, () => page.createSiteFromFlow(form), {
        savingLabel: t("siteAdmin.edit.saving"),
        onError: (error) => {
          if (form.isConnected)
            showFormSaveError(form, siteSaveErrorMessage(error));
        },
      });
    },
  },
  input: { "#new-site-record-form [data-track-empty]": markEmpty },
  change: { "#new-site-record-form [data-track-empty]": markEmpty },
};
