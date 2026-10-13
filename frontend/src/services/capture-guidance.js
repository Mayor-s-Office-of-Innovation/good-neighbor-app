import { listChecks } from "./api.js";
import { startingGuidance } from "../domain/capture-guidance.js";

/**
 * Read every page: checks are ordered by start, while guidance uses completion
 * day, so an old start date cannot safely terminate pagination.
 * @param {{id: string, startedAt: string}} check
 * @returns {Promise<{titleKey: string}>}
 */
export async function loadStartingGuidance(check) {
  const headers = [];
  let nextToken;
  do {
    const page = await listChecks({ limit: 100, nextToken });
    headers.push(...page.checks);
    nextToken = page.nextToken;
  } while (nextToken);
  return startingGuidance(headers, check.startedAt, check.id);
}
