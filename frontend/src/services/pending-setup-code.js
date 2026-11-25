// The setup code from an invitation link, held in memory only. Setup strips the
// code from the address bar right away (so it doesn't sit in history), but the
// "Open in browser" handoff from an in-app webview still has to carry it to the
// real browser (services/browser-escape.js). Cleared once the code is validated.

let pending = "";

/** @param {string} code the raw code read from the URL */
export function rememberSetupCode(code) {
  pending = String(code || "").trim();
}

/** @returns {string} the remembered code, or "" */
export function pendingSetupCode() {
  return pending;
}

export function forgetSetupCode() {
  pending = "";
}
