// Closing rules shared by the record panel and its photo viewer, both native modal dialogs.

/** @param {Element} box @param {MouseEvent} event */
function outside(box, event) {
  const r = box.getBoundingClientRect();
  return (
    event.clientX < r.left ||
    event.clientX > r.right ||
    event.clientY < r.top ||
    event.clientY > r.bottom
  );
}

/**
 * Closes the dialog on a click on its backdrop. Padding inside the dialog is
 * the dialog too, so only a point outside its box counts. A press that starts
 * inside, such as selecting text and letting go outside, doesn't.
 * @param {HTMLDialogElement} dialog
 * @param {() => void} close
 */
export function closeOnBackdrop(dialog, close) {
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (event) => {
    pressedOutside = event.target === dialog && outside(dialog, event);
  });
  dialog.addEventListener("click", (event) => {
    const hit =
      pressedOutside && event.target === dialog && outside(dialog, event);
    pressedOutside = false;
    if (hit) close();
  });
}
