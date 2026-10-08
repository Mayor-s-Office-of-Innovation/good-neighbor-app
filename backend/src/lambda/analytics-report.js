// Entrypoint for the scheduled analytics-report Lambda (ADR 0013 Phase 4).
// Bundled to dist/analytics-report/index.mjs; handler is `index.handler`.
// The reports are the catalog entries flagged `scheduled` in
// backend/src/analytics/catalog.js — the same SQL the admin analytics page
// runs on demand.

import { withServerErrorsLogged } from "../lib/log-server-error.js";
import { runScheduledReports } from "../analytics/reports.js";

/**
 * @returns {Promise<{ reports: string[] }>}
 */
export const handler = () =>
  withServerErrorsLogged("analytics-report", () => runScheduledReports());
