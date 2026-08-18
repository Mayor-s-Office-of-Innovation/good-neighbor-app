/**
 * @typedef {import("./rule-catalog.js").GuidanceCatalog} GuidanceCatalog
 */

/**
 * @param {string} value
 * @returns {string}
 */
const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * @param {string} analyzerCategory
 * @param {GuidanceCatalog} catalog
 * @returns {{ kind: "resolved", category: string, resolution: "exact" | "alias" } | { kind: "unresolved", analyzerCategory: string }}
 */
export function resolveCategory(analyzerCategory, catalog) {
  const normalized = normalize(analyzerCategory);

  for (const rule of catalog.rules) {
    if (normalize(rule.category) === normalized) {
      return { kind: "resolved", category: rule.category, resolution: "exact" };
    }
  }

  for (const alias of catalog.aliases) {
    if (normalize(alias.analyzerCategory) === normalized) {
      return {
        kind: "resolved",
        category: alias.canonicalCategory,
        resolution: "alias",
      };
    }
  }

  return { kind: "unresolved", analyzerCategory };
}
