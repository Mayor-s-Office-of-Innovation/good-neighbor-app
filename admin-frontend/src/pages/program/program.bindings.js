// Program page actions, keyed by event type and the control's data attribute.
// <admin-program-page> listens once per event type, so a redraw can't drop or double a handler.
import { asForm } from "../../dom.js";
import { addExtension, removeExtension } from "../../phone-extension.js";
import { saveWithFeedback } from "../../save-feedback.js";

/**
 * @typedef {import("./program-page.js").ProgramPageElement} ProgramPageElement
 * @typedef {(page: ProgramPageElement, control: HTMLElement, event: Event) => void} ProgramAction
 */

/** @type {Record<string, Record<string, ProgramAction>>} */
export const programEvents = {
  click: {
    "data-add-program-staff": (page) =>
      page.querySelector("#add-program-staff-dialog")?.showModal(),
    "data-cancel-program-staff": (page) =>
      page.querySelector("#add-program-staff-dialog")?.close(),
    "data-edit-program-staff": (page, button) =>
      page
        .querySelector(
          `#edit-program-staff-${CSS.escape(button.dataset.editProgramStaff || "")}`,
        )
        ?.showModal(),
    "data-cancel-program-staff-edit": (page, button) =>
      button.closest("dialog")?.close(),
    "data-add-extension": (page, button) => addExtension(button),
    "data-remove-extension": (page, button) => removeExtension(button),
  },
  submit: {
    "data-program-details-form": (page, control, event) => {
      event.preventDefault();
      const form = asForm(control);
      void saveWithFeedback(form, () => page.updateProgramDetails(form));
    },
    "data-new-program-form": (page, control, event) => {
      event.preventDefault();
      const form = asForm(control);
      void saveWithFeedback(form, () => page.createProgram(form));
    },
    "data-program-staff-form": (page, form, event) => {
      event.preventDefault();
      page
        .addProgramStaff(asForm(form))
        .catch((error) => page.reportError(error));
    },
    "data-program-staff-edit-form": (page, form, event) => {
      event.preventDefault();
      page
        .saveProgramStaff(asForm(form))
        .catch((error) => page.reportError(error));
    },
  },
};
