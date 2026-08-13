// @ts-nocheck -- lenient migration baseline (checkJs). Ratchet target: remove this line and add JSDoc types, one file per PR. See memory step2-gnp-port-scope.
/*
  Tiny History-API router. Uses pathname routing (not hash) — served at the site
  root on S3/CloudFront, with a CloudFront error-response fallback to index.html so
  deep links / refreshes don't 404 (that fallback is provisioned with the deploy
  stage; Vite's dev/preview server already serves the SPA fallback locally).

  Routes: /today (home 5a/5b), /check (capture 5c), /review (5d), /results (5e).
  First-run site setup is enforced by app-root, not by a route.
*/
const listeners = new Set();

export function currentRoute() {
  const path = location.pathname;
  return !path || path === "/" ? "/today" : path;
}

export function navigate(route) {
  if (location.pathname === route) {
    emit();
  } else {
    history.pushState({}, "", route);
    emit();
  }
}

function emit() {
  const route = currentRoute();
  listeners.forEach((fn) => fn(route));
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

window.addEventListener("popstate", emit);

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
