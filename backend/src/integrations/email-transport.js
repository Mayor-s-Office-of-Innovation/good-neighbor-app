import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

const ses = new SESv2Client({});
const secrets = new SecretsManagerClient({});
const SMTP_TRANSPORT_TTL_MS = 5 * 60 * 1000;

/** @type {import("nodemailer").Transporter | undefined} */
let smtpTransport;
let smtpTransportCreatedAt = 0;

/**
 * @typedef {object} OutboundEmail
 * @property {string} from
 * @property {string} to
 * @property {string} subject
 * @property {string} text
 * @property {string} html
 * @property {string | undefined} replyTo
 */

/**
 * Send through the environment-selected transport.
 * @param {OutboundEmail} email
 * @returns {Promise<{provider: "ses" | "smtp", messageId: string}>}
 */
export async function sendEmail(email) {
  if (configuredEmailProvider() === "smtp") {
    const response = await sendSmtpEmail(email);
    if (!response.messageId) throw new Error("Missing SMTP message ID");
    return { provider: "smtp", messageId: response.messageId };
  }

  const response = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: email.from,
      Destination: { ToAddresses: [email.to] },
      ...(email.replyTo && { ReplyToAddresses: [email.replyTo] }),
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: email.text, Charset: "UTF-8" },
            Html: { Data: email.html, Charset: "UTF-8" },
          },
        },
      },
    }),
  );
  if (!response.MessageId) throw new Error("Missing SES message ID");
  return { provider: "ses", messageId: response.MessageId };
}

/**
 * Retry exactly once when SMTP explicitly rejects authentication. Network and
 * timeout errors may occur after delivery, so retrying those could duplicate a
 * message.
 * @param {OutboundEmail} email
 * @param {boolean} [canRetryAuthentication]
 * @returns {Promise<import("nodemailer").SentMessageInfo>}
 */
async function sendSmtpEmail(email, canRetryAuthentication = true) {
  const transport = await getSmtpTransport();
  try {
    return await transport.sendMail({
      from: email.from,
      envelope: { from: email.from, to: [email.to] },
      to: email.to,
      ...(email.replyTo && { replyTo: email.replyTo }),
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  } catch (error) {
    if (isSmtpAuthenticationError(error)) {
      invalidateSmtpTransport();
      if (canRetryAuthentication) return sendSmtpEmail(email, false);
    }
    throw error;
  }
}

/** @returns {"ses" | "smtp"} */
export function configuredEmailProvider() {
  return process.env.EMAIL_TRANSPORT === "smtp" ? "smtp" : "ses";
}

/** @returns {Promise<import("nodemailer").Transporter>} */
async function getSmtpTransport() {
  if (
    smtpTransport &&
    Date.now() - smtpTransportCreatedAt < SMTP_TRANSPORT_TTL_MS
  ) {
    return smtpTransport;
  }
  invalidateSmtpTransport();

  const host = requiredEnvironment("MAIL_MANAGER_SMTP_HOST");
  const username = requiredEnvironment("MAIL_MANAGER_SMTP_USERNAME");
  const secretArn = requiredEnvironment("MAIL_MANAGER_SMTP_SECRET_ARN");
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  if (!response.SecretString) throw new Error("Missing SMTP secret value");

  let value;
  try {
    value = JSON.parse(response.SecretString);
  } catch {
    throw new Error("Invalid SMTP secret value");
  }
  if (!value || typeof value.password !== "string" || !value.password) {
    throw new Error("Invalid SMTP secret value");
  }

  smtpTransport = nodemailer.createTransport({
    host,
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
    auth: { user: username, pass: value.password },
    tls: { minVersion: "TLSv1.2", servername: host },
  });
  smtpTransportCreatedAt = Date.now();
  return smtpTransport;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isSmtpAuthenticationError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EAUTH"
  );
}

/** Close and discard any cached SMTP transport. */
function invalidateSmtpTransport() {
  const transport = smtpTransport;
  smtpTransport = undefined;
  smtpTransportCreatedAt = 0;
  transport?.close();
}

/**
 * @param {string} name
 * @returns {string}
 */
function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

/** Reset warm-runtime state for isolated tests. */
export function resetEmailTransportForTest() {
  if (process.env.NODE_ENV !== "test") return;
  invalidateSmtpTransport();
}
