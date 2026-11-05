// AdminApp.bind() adds these again after each render() replaces the HTML.
import { asForm } from "../../dom.js";

/**
 * @typedef {import("../../admin-types.js").AdminAppElement} AdminAppElement
 */

/** @param {AdminAppElement} app */
export function bindProgram(app) {
  app
    .querySelector("#program-details-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = asForm(event.currentTarget);
      void app.saveWithFeedback(form, () => app.updateProgramDetails(form));
    });
  app.querySelector("#program-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = asForm(e.currentTarget);
    void app.saveWithFeedback(form, () => app.createProgram(form));
  });
  app
    .querySelector("#add-program-staff")
    ?.addEventListener("click", () =>
      app.querySelector("#add-program-staff-dialog")?.showModal(),
    );
  app
    .querySelector("#cancel-program-staff")
    ?.addEventListener("click", () =>
      app.querySelector("#add-program-staff-dialog")?.close(),
    );
  app
    .querySelector("#program-staff-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      app.addProgramStaff(asForm(event.currentTarget)).catch((error) => {
        app.state.error = error.message;
        app.render();
      });
    });
  app.querySelectorAll("[data-edit-program-staff]").forEach((button) => {
    button.addEventListener("click", () =>
      app
        .querySelector(
          `#edit-program-staff-${CSS.escape(button.dataset.editProgramStaff)}`,
        )
        ?.showModal(),
    );
  });
  app.querySelectorAll("[data-cancel-program-staff-edit]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog")?.close());
  });
  app.querySelectorAll("[data-program-staff-edit-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      app.saveProgramStaff(asForm(form));
    });
  });
}
