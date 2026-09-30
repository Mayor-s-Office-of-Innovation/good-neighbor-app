// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  screen-focus — the route-announcement counterpart of <main tabindex="-1">.

  app-root mounts a screen and falls back to focusing <main>, but screens
  whose content renders AFTER async setup (getSite, draft loads, backend
  fetches) may not have their heading yet at mount time — screen code calls
  announceScreenHeading() at the END of its async init so a screen reader
  reliably announces the screen title on every arrival, including direct
  loads. The element is skipped if it's gone (route changed again) and the
  focus is programmatic-only (tabindex="-1", ringless by CSS).
*/

/**
 * Focus this screen's title for the route-change announcement.
 * @param {HTMLElement} host the custom element root to resolve within
 * @param {string} selector for the screen's programmatic focus point
 */
export function announceScreenHeading(host, selector) {
  if (!host.isConnected) return;
  (window.requestAnimationFrame || ((fn) => fn()))(() => {
    // Re-query inside the frame: the screen may have re-rendered (or
    // unmounted) since this call.
    if (!host.isConnected) return;
    const target = host.querySelector(selector);
    if (target instanceof HTMLElement) target.focus();
  });
}
