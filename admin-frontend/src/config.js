/**
 * Runtime config for the static admin app. Deployed builds can provide
 * `window.GOOD_NEIGHBOR_ADMIN_CONFIG` before main.js loads; local file previews
 * fall back to empty values and show a configuration error instead of a custom
 * password form.
 * @returns {{ cognitoDomain: string, clientId: string, redirectUri: string, logoutUri: string, apiBase: string, localDebugAdmin: boolean }}
 */
export function getAdminConfig() {
  const globalConfig =
    /** @type {any} */ (window).GOOD_NEIGHBOR_ADMIN_CONFIG ?? {};
  return {
    cognitoDomain: String(globalConfig.cognitoDomain ?? "").replace(/\/$/, ""),
    clientId: String(globalConfig.clientId ?? ""),
    redirectUri: String(globalConfig.redirectUri ?? location.origin + location.pathname),
    logoutUri: String(globalConfig.logoutUri ?? location.origin + "/"),
    apiBase: String(globalConfig.apiBase ?? "").replace(/\/$/, ""),
    localDebugAdmin: Boolean(globalConfig.localDebugAdmin),
  };
}
