// Record page addresses. Each one carries the list it was opened from and the
// records opened before it, so the trail can lead back to each.
import { carriedQuery } from "./insights-routes.js";

/** @typedef {{ kind: "issue" | "check", siteId: string, id: string }} Hop */

// Ten covers real use; a crafted link can't make the trail endless.
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

/**
 * The records listed before `target` on its own page. Going back to a record
 * already in the trail cuts the trail there, so it never repeats.
 * @param {Hop[]} via
 * @param {Hop} current
 * @param {Hop} target
 */
export function viaTo(via, current, target) {
  const path = [...via, current];
  const at = path.findIndex((step) => hopKey(step) === hopKey(target));
  return at === -1 ? path : path.slice(0, at);
}

/**
 * The Check a panel's Issue was opened from, so its trail leads back.
 * @param {Hop | null} current
 * @param {Hop} target
 */
export const panelFrom = (current, target) =>
  target.kind === "issue" && current?.kind === "check" ? current : null;
