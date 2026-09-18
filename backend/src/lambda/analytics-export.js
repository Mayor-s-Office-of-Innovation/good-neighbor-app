// Entrypoint for the scheduled analytics-export Lambda (ADR 0013 Phase 2).
// Bundled to dist/analytics-export/index.mjs; handler is `index.handler`.

import { withServerErrorsLogged } from "../lib/log-server-error.js";
import { handler as runExport } from "../analytics/export.js";

/**
 * @returns {Promise<void>}
 */
export const handler = () =>
  withServerErrorsLogged("analytics-export", () => runExport());
