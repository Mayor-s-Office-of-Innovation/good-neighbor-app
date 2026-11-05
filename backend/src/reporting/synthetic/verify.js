// Answers come from what the generator meant, not exported rows, so counting bugs show.

import { SITE_DAY_METRICS as METRICS } from "../activity.js";

/**
 * @param {{ site_days: Record<string, any>[], site_contacts: Record<string, any>[] }} tables
 * @param {import("./generate.js").Answers} answers
 * @returns {{ checked: number, mismatches: string[], totals: Record<string, number> }}
 */
export function compareWithAnswers(tables, answers) {
  /** @type {Record<string, Record<string, number>>} */
  const projected = {};
  for (const row of tables.site_days) {
    const day =
      row.day instanceof Date
        ? row.day.toISOString().slice(0, 10)
        : String(row.day);
    const k = `${row.siteId}|${day.slice(0, 7)}`;
    projected[k] ??= Object.fromEntries(METRICS.map((m) => [m, 0]));
    for (const m of METRICS) projected[k][m] += Number(row[m] ?? 0);
  }
  const mismatches = [];
  let checked = 0;
  const totals = Object.fromEntries(METRICS.map((m) => [m, 0]));
  for (const k of new Set([
    ...Object.keys(projected),
    ...Object.keys(answers.bySiteMonth),
  ])) {
    for (const m of METRICS) {
      const want = answers.bySiteMonth[k]?.[m] ?? 0;
      const got = projected[k]?.[m] ?? 0;
      totals[m] += got;
      checked += 1;
      if (want !== got)
        mismatches.push(`${k} ${m}: expected ${want}, got ${got}`);
    }
  }
  const contacts = new Map(tables.site_contacts.map((c) => [c.siteId, c]));
  const seen = new Set();
  for (const { siteId } of tables.site_contacts) {
    if (seen.has(siteId))
      mismatches.push(`${siteId}: more than one site_contacts row`);
    seen.add(siteId);
  }
  for (const siteId of new Set([
    ...contacts.keys(),
    ...Object.keys(answers.contacts),
  ])) {
    const want = answers.contacts[siteId] ?? {};
    for (const field of /** @type {const} */ ([
      "publicContact",
      "siteContact",
    ])) {
      checked += 1;
      const got = contacts.get(siteId)?.[field];
      if (got !== want[field])
        mismatches.push(
          `${siteId} ${field}: expected ${want[field]}, got ${got}`,
        );
    }
  }
  return { checked, mismatches, totals };
}
