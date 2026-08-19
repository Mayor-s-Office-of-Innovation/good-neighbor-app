import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";

const CATALOGS = new Map([
  [actionsEscalationsV2Catalog.policyVersion, actionsEscalationsV2Catalog],
]);

/**
 * @param {string | undefined | null} policyVersion
 * @returns {import("./rule-catalog.js").GuidanceCatalog}
 */
export function catalogForPolicyVersion(policyVersion) {
  const catalog = policyVersion ? CATALOGS.get(policyVersion) : null;
  if (!catalog) {
    const err = new Error(`Guidance catalog unavailable: ${policyVersion}`);
    err.name = "CatalogUnavailable";
    throw err;
  }
  return catalog;
}

/**
 * @returns {import("./rule-catalog.js").GuidanceCatalog}
 */
export function activeCatalog() {
  return actionsEscalationsV2Catalog;
}
