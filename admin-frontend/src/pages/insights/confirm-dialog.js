// One confirm step for every Insights job, so Overview's report and Raw
// data's export ask the same way.

/**
 * Confirm runs what the dialog showed, even if a load lands meanwhile.
 * @param {HTMLElement} host
 * @param {{ id: string, markup: string, button: string, confirmed: () => void }} ask
 * button: the job button's ID; it shows the job's progress, so focus goes back to it
 */
export function confirmFirst(host, { id, markup, button, confirmed }) {
  host.querySelector(`#${id}`)?.remove();
  host.insertAdjacentHTML("beforeend", markup);
  const dialog = /** @type {HTMLDialogElement} */ (
    host.querySelector(`#${id}`)
  );
  dialog.addEventListener(
    "close",
    () => {
      const ok = dialog.returnValue === "confirm";
      dialog.remove();
      if (ok) confirmed();
      /** @type {HTMLElement | null} */ (
        host.querySelector(`#${button}`)
      )?.focus();
    },
    { once: true },
  );
  dialog.showModal();
}
