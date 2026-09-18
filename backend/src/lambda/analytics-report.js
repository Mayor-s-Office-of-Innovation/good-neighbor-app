// Entrypoint for the scheduled analytics-report Lambda (ADR 0013 Phase 4).
// Bundled to dist/analytics-report/index.mjs; handler is `index.handler`.
// The build copies backend/src/analytics/reports/*.sql next to the bundle so
// the .sql files are repo-tracked and laptop-runnable.

import { withServerErrorsLogged } from "../lib/log-server-error.js";
import { runScheduledReports } from "../analytics/reports.js";

/**
 * @returns {Promise<{ reports: string[] }>}
 */
export const handler = () =>
  withServerErrorsLogged("analytics-report", () => runScheduledReports());
