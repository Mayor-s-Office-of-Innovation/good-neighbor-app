// Entrypoint for the S3-triggered analytics-convert Lambda (ADR 0013 Phase 3).
// Bundled to dist/analytics-convert/index.mjs; handler is `index.handler`.

import { withServerErrorsLogged } from "../lib/log-server-error.js";
import { convertS3Event } from "../analytics/convert.js";

/**
 * @param {import("aws-lambda").S3Event} event
 * @returns {Promise<{ converted: number, files: number, rows: number }>}
 */
export const handler = (event) =>
  withServerErrorsLogged("analytics-convert", () => convertS3Event(event));
