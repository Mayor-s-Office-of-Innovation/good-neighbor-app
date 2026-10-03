import { URLSearchParams } from "node:url";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createHash } from "node:crypto";

const ses = new SESv2Client({});

/**
 * @typedef {object} SetupCodeEmail
 * @property {string} to
 * @property {string} siteName
 * @property {string} code
 * @property {string} expiresAt
 * @property {string} appUrl
 */

/**
 * Send through SES, or preview locally. Lambda must never log redeemable codes.
 * @param {SetupCodeEmail} email
 * @returns {Promise<{ provider: "log" | "ses", messageId: string }>}
 */
export async function sendSetupCodeEmail(email) {
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localPreview =
    !isLambda &&
    (Boolean(process.env.LOCAL_API_PORT) ||
      process.env.SETUP_CODE_EMAIL_LOG_CODES === "true");
  const metadata = {
    marker: "setup_code_email",
    contactHash: createHash("sha256")
      .update(email.to.trim().toLowerCase())
      .digest("hex"),
    siteName: email.siteName,
    expiresAt: email.expiresAt,
  };
  if (localPreview) {
    const messageId = `local-${Date.now()}`;
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "log",
        status: "preview",
        messageId,
        localOpenUrl: setupCodeUrl(email.appUrl, email.code, false),
      }),
    );
    return { provider: "log", messageId };
  }

  try {
    const from = process.env.SETUP_CODE_EMAIL_FROM;
    if (!from) throw new Error("Missing email sender");
    const url = setupCodeUrl(email.appUrl, email.code, true);
    const expires = new Date(email.expiresAt).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
    const replyTo = process.env.SETUP_CODE_EMAIL_REPLY_TO;
    const text = `Your Good Neighbor setup code for ${email.siteName} is:\n\n${email.code}\n\nThis code expires ${expires}.\n\nOpen Good Neighbor:\n${url}\n\nOnly use this code on a trusted work device. Do not share it with unauthorized people.\n\nIf you did not request this code, you can ignore this email.`;
    const html = `<h1>Set up Good Neighbor</h1><p>Your setup code for ${escapeHtml(email.siteName)} is:</p><p><strong>${escapeHtml(email.code)}</strong></p><p>This code expires ${escapeHtml(expires)}.</p><p><a href="${escapeHtml(url)}">Open Good Neighbor</a></p><p>Or copy this link into your browser:<br>${escapeHtml(url)}</p><p>Only use this code on a trusted work device. Do not share it with unauthorized people.</p><p>If you did not request this code, you can ignore this email.</p>`;
    const response = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [email.to] },
        ...(replyTo && { ReplyToAddresses: [replyTo] }),
        Content: {
          Simple: {
            Subject: {
              Data: `${prefix}Your Good Neighbor setup code`,
              Charset: "UTF-8",
            },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
    if (!response.MessageId) throw new Error("Missing SES message ID");
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "ses",
        status: "accepted",
        messageId: response.MessageId,
      }),
    );
    return { provider: "ses", messageId: response.MessageId };
  } catch {
    // SDK error messages may contain recipient addresses or request content.
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: "ses",
        status: "failed",
      }),
    );
    throw new Error("Setup-code email delivery failed");
  }
}

/**
 * Send a single-Site Manager enrollment link. The token may appear in the
 * outbound message but never in logs.
 * @param {{ to: string, managerName: string, siteName: string, enrollmentUrl: string, expiresAt: string }} email
 * @returns {Promise<{ provider: "log" | "ses", messageId: string }>}
 */
export async function sendManagerEnrollmentEmail(email) {
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localPreview = !isLambda && Boolean(process.env.LOCAL_API_PORT);
  const metadata = {
    marker: "manager_enrollment_email",
    contactHash: createHash("sha256")
      .update(email.to.trim().toLowerCase())
      .digest("hex"),
    siteName: email.siteName,
    expiresAt: email.expiresAt,
  };
  if (localPreview) {
    const messageId = `local-${Date.now()}`;
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "log",
        status: "preview",
        messageId,
        localOpenUrl: email.enrollmentUrl,
      }),
    );
    return { provider: "log", messageId };
  }
  try {
    const from = process.env.SETUP_CODE_EMAIL_FROM;
    if (!from) throw new Error("Missing email sender");
    const url = new URL(email.enrollmentUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("Invalid enrollment URL");
    }
    const expires = new Date(email.expiresAt).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      timeZoneName: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
    const replyTo = process.env.SETUP_CODE_EMAIL_REPLY_TO;
    const text = `Hello ${email.managerName},\n\nUse this one-time link to enroll a device as a Site Manager for ${email.siteName}:\n\n${email.enrollmentUrl}\n\nThis link expires ${expires} and enrolls this Site only. Do not forward it.`;
    const html = `<p>Hello ${escapeHtml(email.managerName)},</p><p>Use this one-time link to enroll a device as a Site Manager for ${escapeHtml(email.siteName)}:</p><p><a href="${escapeHtml(email.enrollmentUrl)}">Enroll Site Manager device</a></p><p>This link expires ${escapeHtml(expires)} and enrolls this Site only. Do not forward it.</p>`;
    const response = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [email.to] },
        ...(replyTo && { ReplyToAddresses: [replyTo] }),
        Content: {
          Simple: {
            Subject: {
              Data: `${prefix}Enroll as a Good Neighbor Site Manager`,
              Charset: "UTF-8",
            },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
    if (!response.MessageId) throw new Error("Missing SES message ID");
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "ses",
        status: "accepted",
        messageId: response.MessageId,
      }),
    );
    return { provider: "ses", messageId: response.MessageId };
  } catch {
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: "ses",
        status: "failed",
      }),
    );
    throw new Error("Manager enrollment email delivery failed");
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * @param {string} appUrl
 * @param {string} code
 * @param {boolean} requireHttps
 * @returns {string}
 */
function setupCodeUrl(appUrl, code, requireHttps) {
  const url = new URL(appUrl);
  if (
    requireHttps &&
    (url.protocol !== "https:" || url.username || url.password)
  ) {
    throw new Error("Invalid provider app URL");
  }
  url.searchParams.delete("code");
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.set("code", code);
  url.hash = fragment.toString();
  return url.toString();
}
