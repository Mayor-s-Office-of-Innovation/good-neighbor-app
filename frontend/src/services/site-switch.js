/*
  site-switch — switch the active site binding on this device. Shared by the
  home hub and the manager reports so both screens' site switchers behave
  identically: a site this device already holds a credentialed binding for
  is activated in place (fresh tokens minted server-side); anything else
  needs enrollment, which the caller handles by raising "siterequested".

  Outcomes:
    "same"          the current site was chosen; nothing to do
    "needs-binding" no stored binding for that site; caller starts setup
    "blocked"       a captured-but-unsubmitted check must finish first
    "switched"      done; the page is being reloaded onto `destination`
    "failed"        the switch threw; a toast was shown
*/
import { activateSiteBinding, setSite } from "../db.js";
import { selectDeviceBinding } from "./api.js";
import {
  discardInMemorySession,
  getCurrentCheck,
  pauseCheck,
} from "../state/check-session.js";
import {
  queueSiteSwitchSuccessToast,
  showSiteSwitchBlockedToast,
  showSiteSwitchErrorToast,
  showSiteSwitchSuccessToast,
} from "../state/toasts.js";

/**
 * @param {object} input
 * @param {string} input.siteId the chosen site
 * @param {string} input.currentSiteId
 * @param {Array<Record<string, any>>} input.boundSites from listBoundSites()
 * @param {string} [input.destination] route to reload onto (default /today)
 * @returns {Promise<"same" | "needs-binding" | "blocked" | "switched" | "failed">}
 */
export async function switchToBoundSite({
  siteId,
  currentSiteId,
  boundSites,
  destination = "/today",
}) {
  if (!siteId || siteId === currentSiteId) return "same";
  // Provider enrollment stores sibling binding metadata without tokens. The
  // server authorizes that binding and issues its session when selected.
  const bound = boundSites.find(
    (site) =>
      site.siteId === siteId &&
      ((site.bindingId && site.physicalDeviceId) ||
        (site.token && site.refreshToken)),
  );
  if (!bound) return "needs-binding";
  const active = getCurrentCheck();
  if (active?.status === "capture-complete") {
    showSiteSwitchBlockedToast();
    return "blocked";
  }
  try {
    if (active) await pauseCheck();
    let selected;
    if (bound.bindingId && bound.physicalDeviceId) {
      const session = await selectDeviceBinding(bound.bindingId);
      selected = await setSite(session.site.name, {
        siteId: session.site.siteId,
        deviceId: session.deviceId,
        bindingId: session.bindingId,
        physicalDeviceId: session.physicalDeviceId,
        token: session.token,
        refreshToken: session.refreshToken,
        tokenExpiresAt: new Date(
          Date.now() + session.expiresIn * 1000,
        ).toISOString(),
        tokenGeneration: session.tokenGeneration,
        accessLevel: session.accessLevel,
        absoluteExpiresAt: session.absoluteExpiresAt,
      });
    } else {
      selected = await activateSiteBinding(siteId);
    }
    if (!selected) return "needs-binding";
    discardInMemorySession();
    if (!queueSiteSwitchSuccessToast()) showSiteSwitchSuccessToast();
    window.location.assign(destination);
    return "switched";
  } catch (error) {
    console.error("site switch failed", error);
    showSiteSwitchErrorToast();
    return "failed";
  }
}
