// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  dialog-history — connects native <dialog> modals to the router's overlay
  layer so system back / swipe-back closes what it opened.

  openOverlayDialog(dialog, id) replaces a bare `dialog.showModal()` call
  site: it shows the dialog and registers a sentinel history entry under
  `id` (once per id — re-opens after a close never duplicate). Closing stays
  native: X / backdrop / Escape / Done all funnel through the <dialog>'s own
  close(), and the native `close` event unwinds the sentinel. System back
  pops the sentinel instead — the popstate bridge closes the registered
  dialog, whose `close` handler then finds nothing to unwind. Both orders
  converge because push/close are idempotent per id.
*/
import { closeOverlay, onOverlayPop, pushOverlay } from "./router.js";

/** @type {Map<string, HTMLDialogElement>} */
const registry = new Map();
let listenersInstalled = false;

/**
 * Show `dialog` modal with an overlay history entry keyed by `overlayId`.
 * @param {HTMLDialogElement} dialog
 * @param {string} overlayId
 */
export function openOverlayDialog(dialog, overlayId) {
  ensurePopListener();
  registry.set(overlayId, dialog);
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  pushOverlay(overlayId);
  // The native `close` event fires for X, backdrop, Escape, programmatic
  // close, AND for the popstate bridge's own close — closeOverlay is
  // idempotent, so all paths converge on one unwind.
  if (dialog.dataset?.overlayBound !== overlayId) {
    dialog.addEventListener("close", () => closeOverlay(overlayId), {
      once: true,
    });
    if (dialog.dataset) dialog.dataset.overlayBound = overlayId;
  }
}

/**
 * Bind an overlay id to its current dialog element without showing it, so a
 * system-back pop closes the live element after a host re-render handed over
 * a fresh <dialog>. Overwritten on the next open.
 * @param {string} overlayId
 * @param {HTMLDialogElement} dialog
 */
export function registerOverlayDialog(overlayId, dialog) {
  ensurePopListener();
  registry.set(overlayId, dialog);
}

/** Install the one popstate bridge; every pop closes its registered dialog. */
function ensurePopListener() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  onOverlayPop((overlayId) => {
    const dialog = registry.get(overlayId);
    registry.delete(overlayId);
    // Idempotent: closing an already-closed dialog is a no-op.
    dialog?.close();
  });
}
