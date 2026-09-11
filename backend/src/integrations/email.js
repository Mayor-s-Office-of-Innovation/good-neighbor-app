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
  const messageId = `local-${Date.now()}`;
  const localOpenUrl = localCodeLoggingEnabled()
    ? setupCodeUrl(email.appUrl, email.code)
    : undefined;

  console.info(
    JSON.stringify({
      marker: "setup_code_email",
      provider: "log",
      messageId,
      to: email.to,
      siteName: email.siteName,
      expiresAt: email.expiresAt,
      ...(localOpenUrl && { localOpenUrl }),
    }),
  );

  return { provider: "log", messageId };
}

/**
 * @returns {boolean}
 */
function localCodeLoggingEnabled() {
  return (
    process.env.SETUP_CODE_EMAIL_LOG_CODES === "true" ||
    Boolean(process.env.LOCAL_API_PORT)
  );
}

/**
 * @param {string} appUrl
 * @param {string} code
 * @returns {string}
 */
function setupCodeUrl(appUrl, code) {
  const url = new URL(appUrl);
  url.searchParams.set("code", code);
  return url.toString();
}
