import { actionsEscalationsV2Catalog } from "./actions-escalations-v2.js";
import { actionsEscalationsV3Catalog } from "./actions-escalations-v3.js";
import { actionsEscalationsV4Catalog } from "./actions-escalations-v4.js";

import { actionsEscalationsV5Catalog } from "./actions-escalations-v5.js";

import { actionsEscalationsV6Catalog } from "./actions-escalations-v6.js";

const CATALOGS = new Map([
  [actionsEscalationsV6Catalog.policyVersion, actionsEscalationsV6Catalog],
  [actionsEscalationsV5Catalog.policyVersion, actionsEscalationsV5Catalog],
  [actionsEscalationsV2Catalog.policyVersion, actionsEscalationsV2Catalog],
  [actionsEscalationsV3Catalog.policyVersion, actionsEscalationsV3Catalog],
  [actionsEscalationsV4Catalog.policyVersion, actionsEscalationsV4Catalog],
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
  return actionsEscalationsV6Catalog;
}
