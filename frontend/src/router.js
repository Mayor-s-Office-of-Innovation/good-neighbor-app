// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  Tiny History-API router. Uses pathname routing (not hash) — served at the site
  root on S3/CloudFront, with a CloudFront error-response fallback to index.html so
  deep links / refreshes don't 404 (that fallback is provisioned with the deploy
  stage; Vite's dev/preview server already serves the SPA fallback locally).

  Routes include /today (home), capture flows, /site-admin, and the site-admin
  edit paths. First-run site setup is enforced by app-root, not by a route.
*/
const listeners = new Set();
const APP_HISTORY_STATE = "goodNeighborAppNavigation";
let activeDepth =
  typeof history === "undefined"
    ? 0
    : Number(history.state?.[APP_HISTORY_STATE] || 0);
let restoringPopstate = false;
/** @type {null | ((route: string) => boolean | Promise<boolean>)} */
let popstateGuard = null;

export function currentRoute() {
  const path = location.pathname;
  return !path || path === "/" ? "/today" : path;
}

export function navigate(route) {
  if (location.pathname === route) {
    emit();
  } else {
    const depth = Number(history.state?.[APP_HISTORY_STATE] || 0) + 1;
    history.pushState({ [APP_HISTORY_STATE]: depth }, "", route);
    activeDepth = depth;
    emit();
  }
}

/**
 * Return to the preceding in-app route without adding a duplicate history
 * entry. A directly loaded deep link has no app-created predecessor, so it
 * uses the supplied parent route instead.
 * @param {string} fallbackRoute
 */
export function backOrNavigate(fallbackRoute) {
  if (Number(history.state?.[APP_HISTORY_STATE] || 0) > 0) {
    history.back();
    return;
  }
  history.replaceState({ [APP_HISTORY_STATE]: 0 }, "", fallbackRoute);
  activeDepth = 0;
  emit();
}

function emit() {
  const route = currentRoute();
  listeners.forEach((fn) => fn(route));
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Install the single active view's browser-history leave guard.
 * @param {(route: string) => boolean | Promise<boolean>} guard
 * @returns {() => void}
 */
export function setPopstateGuard(guard) {
  popstateGuard = guard;
  return () => {
    if (popstateGuard === guard) popstateGuard = null;
  };
}

window.addEventListener("popstate", async () => {
  const targetDepth = Number(history.state?.[APP_HISTORY_STATE] || 0);
  if (restoringPopstate) {
    restoringPopstate = false;
    return;
  }
  if (popstateGuard && !(await popstateGuard(currentRoute()))) {
    const restoreBy = activeDepth - targetDepth;
    if (restoreBy !== 0) {
      restoringPopstate = true;
      history.go(restoreBy);
    }
    return;
  }
  activeDepth = targetDepth;
  emit();
});

/*
  Delegated link interception: plain left-clicks on same-origin absolute-path
  anchors (href="/today") route through pushState instead of a full page load.
  Modifier clicks, new-tab targets, and downloads fall through to the browser.
*/
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/") || href.startsWith("//")) return;
  if (a.target && a.target !== "_self") return;
  if (a.hasAttribute("download")) return;
  e.preventDefault();
  navigate(href);
});
