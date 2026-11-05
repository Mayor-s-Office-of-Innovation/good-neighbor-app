// One edit-rights check, so every Site page hides or locks the same Site and
// Site manager controls for the signed-in role.

/**
 * @typedef {import("./admin-types.js").AdminState} AdminState
 */

/** @param {AdminState} state */
export function canEditSite(state) {
  return (
    state.capabilities.createEntities === true || state.siteCanEdit === true
  );
}

/** Shared staff changes require access to every assigned Site. @param {AdminState} state */
export function canEditSiteManager(state) {
  if (state.capabilities.createEntities === true) return true;
  const assigned = state.siteManager?.assignedSites || [];
  const id = state.profile?.directoryUserId;
  return Boolean(
    id &&
      assigned.length &&
      assigned.every((site) =>
        state.sites.some(
          (item) =>
            item.siteId === site.siteId &&
            (item.complianceManagerIds || []).includes(id),
        ),
      ),
  );
}
