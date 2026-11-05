// Answers come from what the generator meant, not exported rows, so counting bugs show.

import { SITE_DAY_METRICS as METRICS } from "../activity.js";

/**
 * @param {{ site_days: Record<string, any>[], site_contacts: Record<string, any>[], checks_owed?: Record<string, any>[] }} tables
 * @param {import("./generate.js").Answers} answers
 * @returns {{ checked: number, mismatches: string[], totals: Record<string, number> }}
 */
export function compareWithAnswers(tables, answers) {
  /** @param {Record<string, any>} row */
  const monthKey = (row) =>
    `${row.siteId}|${(row.day instanceof Date ? row.day.toISOString() : String(row.day)).slice(0, 7)}`;
  /** @type {Record<string, Record<string, number>>} */
  const projected = {};
  for (const row of tables.site_days) {
    const k = monthKey(row);
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
  /** @type {Record<string, number>} */
  const owed = {};
  for (const row of tables.checks_owed ?? [])
    owed[monthKey(row)] = (owed[monthKey(row)] ?? 0) + Number(row.checksOwed);
  const wantOwed = answers.owedBySiteMonth ?? {};
  for (const k of new Set([...Object.keys(owed), ...Object.keys(wantOwed)])) {
    checked += 1;
    if ((owed[k] ?? 0) !== (wantOwed[k] ?? 0))
      mismatches.push(
        `${k} checksOwed: expected ${wantOwed[k] ?? 0}, got ${owed[k] ?? 0}`,
      );
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
