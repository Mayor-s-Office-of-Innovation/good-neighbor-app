// Entrypoint for the Lambda the convert Lambda invokes each time it succeeds,
// so Insights is never much older than the last export. Bundled to
// dist/analytics-projection/index.mjs; handler is `index.handler`.

import { withServerErrorsLogged } from "../lib/log-server-error.js";
import { buildLatestProjection } from "../reporting/publish-projection.js";

/**
 * @returns {Promise<{ prefix: string, snapshotId: string }>}
 */
export const handler = () =>
  withServerErrorsLogged("analytics-projection", () => buildLatestProjection());
