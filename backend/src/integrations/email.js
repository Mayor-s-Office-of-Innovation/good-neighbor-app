/**
 * @typedef {object} SetupCodeEmail
 * @property {string} to
 * @property {string} siteName
 * @property {string} code
 * @property {string} expiresAt
 * @property {string} appUrl
 */

/**
 * Send a setup-code email. The first implementation is a local/log sink so the
 * lifecycle can be developed without adding an email dependency; production SES
 * wiring can replace this module behind the same function contract.
 * @param {SetupCodeEmail} email
 * @returns {Promise<{ provider: "log", messageId: string }>}
 */
export async function sendSetupCodeEmail(email) {
  const url = new URL(email.appUrl);
  url.searchParams.set("code", email.code);
  const messageId = `local-${Date.now()}`;

  console.info(
    JSON.stringify({
      marker: "setup_code_email",
      provider: "log",
      messageId,
      to: email.to,
      siteName: email.siteName,
      expiresAt: email.expiresAt,
      openUrl: url.toString(),
      // Intentionally omit the raw code from structured logs.
    }),
  );

  return { provider: "log", messageId };
}
