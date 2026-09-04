/*
  api-error.js — the error types shared by the API layer (services/api.js) and
  the device session service (services/devices.js). A separate module because
  api.js imports devices.js: if devices.js imported these back from api.js the
  two would form a cycle. The auth contract depends on both layers throwing
  the SAME ApiError class — the 401 mapping in api.js matches on `instanceof`,
  so a plain Error from the refresh path can never be recognized as fatal.
*/

/** A non-2xx response or a transport failure from the backend. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number} [opts.status]  HTTP status (0 = network/transport failure)
   * @param {unknown} [opts.body]   parsed error body, when the server sent one
   */
  constructor(message, { status = 0, body = undefined } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Raised when the device session cannot be renewed (refresh rejected after the
 * access token died — months of disuse, or the device was revoked). Callers
 * should route the user back to site setup; nothing else recovers from this.
 */
export class ReauthRequiredError extends ApiError {
  constructor() {
    super("Device session expired — re-registration (site code) required", {
      status: 401,
    });
    this.name = "ReauthRequiredError";
  }
}
