// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  Tiny History-API router. Uses pathname routing (not hash) — served at the site
  root on S3/CloudFront, with the frontend_spa_rewrite viewer-request function
  rewriting non-asset paths to /index.html before the S3 origin so deep links /
  refreshes don't 404 (infra/modules/app/cloudfront.tf; Vite's dev/preview
  server serves the SPA fallback locally).

  Routes include /today (home), capture flows, /site-admin, and the site-admin
  edit paths. First-run site setup is enforced by app-root, not by a route.

  On top of routes the router tracks ONE transient overlay layer: dialogs and
  the embedded capture phase push sentinel entries carrying
  `goodNeighborOverlay: "<id>"` (URL unchanged) so system back closes what it
  opened. A pop whose pathname is unchanged hands the popped id to overlay
  closers instead of re-rendering the view (a re-render would destroy
  mid-capture state). Overlay ids are tracked in `overlayDepths`, so re-shown
  dialogs (today-view re-renders recreate its <dialog> elements) never push a
  second sentinel, and a refresh mid-overlay adopts or strips the stale entry.
*/
const listeners = new Set();
/** @type {Set<(overlayId: string) => void>} */
const overlayListeners = new Set();
const APP_HISTORY_STATE = "goodNeighborAppNavigation";
const OVERLAY_STATE = "goodNeighborOverlay";
const overlayDepths = new Map();
let topOverlayId = null;
let pendingOverlayPop = null;
let pendingOverlayDepth = 0;
/** Resolved when the pending unwind lands; awaited by closeOverlay callers. */
let landedOverlayPop = null;
/** @type {null | (() => void)} resolves landedOverlayPop (popstate side). */
let pendingOverlayResolve = null;
let activeDepth =
  typeof history === "undefined"
    ? 0
    : Number(history.state?.[APP_HISTORY_STATE] || 0);
let lastRoute = typeof location === "undefined" ? "/today" : currentRoute();
let restoringPopstate = false;
/** @type {null | ((route: string) => boolean | Promise<boolean>)} */
let popstateGuard = null;

/** Resolve (and drop) the awaited unwind promise, if one is pending. */
function landResolvePending() {
  const resolve = pendingOverlayResolve;
  pendingOverlayResolve = null;
  resolve?.();
}

// A refresh while an overlay was open re-loads on its sentinel entry. The
// overlay is live-only (dialogs aren't restored), so strip the marker —
// otherwise the first back press would be spent on an invisible entry.
if (
  typeof history !== "undefined" &&
  history.state?.[OVERLAY_STATE] &&
  typeof history.replaceState === "function"
) {
  const rest = { ...history.state };
  delete rest[OVERLAY_STATE];
  // A refresh mid-dialog re-loads on `#<dialogId>`; the hash is
  // live-only (no deep-link contract) — drop it too.
  history.replaceState(rest, "", location.pathname + location.search);
}

function stateDepth(state) {
  return Number(state?.[APP_HISTORY_STATE] || 0);
}

/** History available? (Test environments may run the router without one.) */
function hasHistory() {
  return typeof history !== "undefined" && !!history.pushState;
}

function nextDepth() {
  return Math.max(activeDepth, stateDepth(history.state)) + 1;
}

export function currentRoute() {
  const path = location.pathname;
  return !path || path === "/" ? "/today" : path;
}

/**
 * Open dialog sub-state, mirrored in the URL as `#<dialogId>` so the history
 * entry is visible and forward/back is self-describing. Stripped when the
 * dialog closes. NOT a deep-link contract: refresh restores the view but
 * re-opens only dialogs flagged restorable (see dialog-history.js).
 * @param {string} overlayId
 */
function overlayHash(overlayId) {
  return `#${overlayId}`;
}

export function navigate(route) {
  if (location.pathname === route) {
    emit();
  } else {
    const depth = nextDepth();
    history.pushState({ [APP_HISTORY_STATE]: depth }, "", route);
    activeDepth = depth;
    emit();
  }
}

/**
 * Switch to `route` WITHOUT adding a history entry, replacing the current
 * one. Used where arriving at the destination means the previous screen is
 * dead (routed capture flows replacing themselves with /today on finish), so
 * browser back must never revisit it.
 * @param {string} route
 */
export function replaceRoute(route) {
  history.replaceState(
    { [APP_HISTORY_STATE]: stateDepth(history.state) },
    "",
    route,
  );
  emit();
}

/**
 * Push a sentinel entry for a transient overlay (dialog). The route is
 * unchanged; the URL gains a short-lived `#<dialogId>` hash and the id rides
 * in history.state, so popstate can tell "close the overlay" apart from
 * "change the view" AND the entry is visible in the URL. Idempotent per id:
 * re-showing an already-open id (a dialog re-shown after today-view
 * re-rendered) must not push a duplicate entry.
 * @param {string} overlayId
 */
export function pushOverlay(overlayId) {
  if (overlayDepths.has(overlayId)) return;
  if (!hasHistory()) return;
  const depth = nextDepth();
  history.pushState(
    { [APP_HISTORY_STATE]: depth, [OVERLAY_STATE]: overlayId },
    "",
    overlayHash(overlayId),
  );
  overlayDepths.set(overlayId, depth);
  activeDepth = depth;
  topOverlayId = overlayId;
}

/**
 * Unwind the sentinel entry for `overlayId` (or the topmost one). Idempotent:
 * System back already removed the entry, this is a no-op. App-side closes (X
 * / backdrop / finish) all funnel through here so the history stack and the
 * open overlays unwind together. Guard-internal dialogs (site-admin discard
 * confirm) never push a sentinel, so they never call this.
 *
 * Returns a Promise resolved once the unwind has LANDED in history (popstate
 * delivered) — a traversal is asynchronous, so callers that continue with
 * further history mutations (flow exits replacing the entry with /today)
 * MUST await it first; mutating history beneath a queued traversal replaces
 * the wrong entry.
 * @param {string} [overlayId]
 * @returns {Promise<void>}
 */
export function closeOverlay(overlayId) {
  if (!hasHistory()) return Promise.resolve();
  const id = overlayId ?? topOverlayId;
  if (!id || pendingOverlayPop) {
    // System back already unwound it (or an unwind is in flight); the pop's
    // resolution covers that in-flight case too.
    return landedOverlayPop ?? Promise.resolve();
  }
  if (history.state?.[OVERLAY_STATE] !== id) {
    // Authoritative check: the sentinel is on top iff the current entry
    // carries its marker. System back already unwound it (popstate may still
    // be in flight); nothing to do.
    topOverlayId = null;
    return landedOverlayPop ?? Promise.resolve();
  }
  // Optimistic bookkeeping: retire the id NOW so an immediate re-open pushes
  // a fresh sentinel even before popstate delivers. Record the sentinel's
  // own depth so popstate's stale-guard can verify the landing position.
  const unwoundDepth = /** @type {number} */ (overlayDepths.get(id) ?? 0);
  overlayDepths.delete(id);
  pendingOverlayPop = id;
  pendingOverlayDepth = unwoundDepth;
  topOverlayId = null;
  landedOverlayPop = new Promise((resolve) => {
    pendingOverlayResolve = resolve;
  });
  history.back();
  return landedOverlayPop;
}

/**
 * Subscribe to overlay pops: system back removing an overlay sentinel (or
 * landing on one via history.forward). Exactly one consumer owns each id and
 * must be idempotent — closing an already-closed dialog is a no-op.
 * @param {(overlayId: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onOverlayPop(fn) {
  overlayListeners.add(fn);
  return () => overlayListeners.delete(fn);
}

function emitOverlay(overlayId) {
  overlayListeners.forEach((fn) => fn(overlayId));
}

/**
 * Return to the preceding in-app route without adding a duplicate history
 * entry. A directly loaded deep link has no app-created predecessor, so it
 * uses the supplied parent route instead. Also the completion path for routed
 * capture flows: finishing pops the flow's entry, so back can never revisit
 * the finished screen.
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
  lastRoute = currentRoute();
  listeners.forEach((fn) => fn(lastRoute));
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

if (typeof window !== "undefined") {
  window.addEventListener("popstate", async () => {
    if (restoringPopstate) {
      restoringPopstate = false;
      return;
    }
    const state = history.state;
    const route = currentRoute();
    const routeChanged = route !== lastRoute;
    const pendingId = pendingOverlayPop;
    pendingOverlayPop = null;
    if (!routeChanged) {
      /*
        Overlay unwind (or a forward-land on a sentinel): same pathname, so
        the view must NOT re-render. After the pop the entry beneath may
        itself be a sentinel (nested overlay), so adopt it.
      */
      if (stateDepth(state) > activeDepth) {
        /*
          Forward-land on a sentinel whose dialog already dismissed (Back
          closed it; Forward re-enters the entry). Re-opening would surprise;
          the mobile convention is that Forward through a dismissed sheet is
          a no-op — normalize the entry (strip marker + hash) and keep going.
        */
        const staleId = /** @type {string} */ (state?.[OVERLAY_STATE]) || null;
        if (staleId) overlayDepths.delete(staleId);
        activeDepth = stateDepth(state);
        topOverlayId = null;
        history.replaceState(
          { [APP_HISTORY_STATE]: activeDepth },
          "",
          location.pathname + location.search,
        );
        landResolvePending();
        return;
      }
      const poppedId = pendingId || topOverlayId;
      // Stale-pop guard: an app-side unwind recorded the sentinel's depth;
      // the landing must sit exactly beneath it. (A re-open between back()
      // and popstate would shift the stack — such a pop is stale and closers
      // must not fire.)
      const isTopSentinel =
        pendingId === null ||
        (pendingOverlayDepth > 0 &&
          stateDepth(state) === pendingOverlayDepth - 1);
      pendingOverlayDepth = 0;
      activeDepth = stateDepth(state);
      topOverlayId = /** @type {string} */ (state?.[OVERLAY_STATE]) || null;
      if (poppedId && isTopSentinel) {
        // Retire the popped id BEFORE notifying closers: bookkeeping must be
        // consistent by the time consumer code runs, or a close handler that
        // re-opens another dialog on top of this id would short-circuit.
        overlayDepths.delete(poppedId);
        landResolvePending();
        emitOverlay(poppedId);
        return;
      }
      landResolvePending();
      return;
    }
    topOverlayId = /** @type {string} */ (state?.[OVERLAY_STATE]) || null;
    if (popstateGuard && !(await popstateGuard(route))) {
      landResolvePending();
      const restoreBy = activeDepth - stateDepth(state);
      if (restoreBy) {
        restoringPopstate = true;
        history.go(restoreBy);
      }
      return;
    }
    // A route change retires every overlay above the popped entry (their
    // DOM dies with the old view anyway).
    overlayDepths.clear();
    activeDepth = stateDepth(state);
    landResolvePending();
    emit();
  });
}

if (typeof document !== "undefined") {
  /*
    Delegated link interception: plain left-clicks on same-origin absolute-path
    anchors (href="/today") route through pushState instead of a full page
    load. Modifier clicks, new-tab targets, and downloads fall through to the
    browser.
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
}
