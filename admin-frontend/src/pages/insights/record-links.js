// Record addresses. Each carries the list it came from and the records
// walked through on the way, so the trail can lead back to each one.
import { carriedQuery } from "./insights-routes.js";

/** @typedef {{ kind: "issue" | "check", siteId: string, id: string }} Hop */

// Enough for any real walk; a crafted link can't make the trail run on.
export const MAX_HOPS = 10;

/** @param {Hop} hop */
export const hopKey = (hop) => `${hop.kind}|${hop.siteId}|${hop.id}`;

/**
 * @param {Hop} hop
 * @param {{ search: string, back: string, via?: Hop[] }} from back is a path safeReturnPath accepts, or ""
 */
export function recordHref(hop, { search, back, via = [] }) {
  const query = new URLSearchParams(carriedQuery(search));
  // Two Sites can share a record ID, so the record needs its Site.
  query.set("siteId", hop.siteId);
  if (back) query.set("return", back);
  for (const step of via.slice(-MAX_HOPS))
    query.append(
      "via",
      [step.kind, step.siteId, step.id].map(encodeURIComponent).join(":"),
    );
  return `/insights/raw/${hop.kind}s/${encodeURIComponent(hop.id)}?${query}`;
}

/** @param {string} search @returns {Hop[]} */
export function readVia(search) {
  /** @type {Hop[]} */
  const hops = [];
  for (const value of new URLSearchParams(search).getAll("via")) {
    const parts = value.split(":");
    if (parts.length !== 3) continue;
    /** @type {string[]} */
    let decoded;
    try {
      decoded = parts.map(decodeURIComponent);
    } catch {
      continue;
    }
    const [kind, siteId, id] = decoded;
    if ((kind === "issue" || kind === "check") && siteId && id)
      hops.push({ kind, siteId, id });
  }
  return hops.slice(-MAX_HOPS);
}
