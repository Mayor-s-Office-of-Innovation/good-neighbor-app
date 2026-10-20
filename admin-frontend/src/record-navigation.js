/** Select only the loaded record matching the active route.
 * @param {{ provider?: any, program?: any, site?: any, siteManager?: any }} state
 * @param {{ name: string, id?: string }} route
 */
export function visibleRecords(state, route) {
  return {
    provider:
      route.name === "provider" && state.provider?.providerId === route.id
        ? state.provider
        : null,
    program:
      route.name === "program" && state.program?.programId === route.id
        ? state.program
        : null,
    site:
      route.name === "site" && state.site?.siteId === route.id
        ? state.site
        : null,
    siteManager:
      route.name === "manager" && state.siteManager?.userId === route.id
        ? state.siteManager
        : null,
  };
}
