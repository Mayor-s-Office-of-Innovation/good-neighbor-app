// Entrypoint for the S3-triggered analytics-convert Lambda (ADR 0013 Phase 3).
// Bundled to dist/analytics-convert/index.mjs; handler is `index.handler`.

import { withServerErrorsLogged } from "../lib/log-server-error.js";
import { convertS3Event } from "../analytics/convert.js";

/**
 * @param {import("aws-lambda").S3Event} event
 * @param {import("aws-lambda").Context} context
 * @returns {Promise<{ converted: number, files: number, rows: number, backfilled: number }>}
 */
export const handler = (event, context) =>
  withServerErrorsLogged("analytics-convert", () =>
    convertS3Event(event, context),
  );
