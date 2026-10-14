import {
  CommitmentPolicy,
  KmsKeyringNode,
  buildClient,
} from "@aws-crypto/client-node";
import { sendEmail } from "../integrations/email-transport.js";

const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);

/**
 * @typedef {object} CognitoEmailEvent
 * @property {string} userPoolId
 * @property {string} userName
 * @property {string} triggerSource
 * @property {{type:string, code?:string, userAttributes:Record<string,string>}} request
 */

/** @param {CognitoEmailEvent} event */
export async function handler(event) {
  if (event.request.type !== "customEmailSenderRequestV1") {
    throw new Error("Unexpected custom sender request");
  }
  const to = event.request.userAttributes.email;
  if (!to || !/^\S+@\S+$/.test(to)) throw new Error("Missing recipient email");

  let secret = "";
  if (event.request.code) {
    secret = await decryptSecret(event.request.code, event.userPoolId);
    if (event.triggerSource === "CustomEmailSender_AdminCreateUser") {
      secret = decodeCognitoPassword(secret);
    }
  }
  const message = messageForEvent(event, secret);
  const from = requiredEnvironment("SETUP_CODE_EMAIL_FROM");
  const response = await sendEmail({
    from,
    to,
    replyTo: from,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  console.info(
    JSON.stringify({
      marker: "cognito_custom_email_sender",
      triggerSource: event.triggerSource,
      provider: response.provider,
      status: "accepted",
      messageId: response.messageId,
    }),
  );
}

/**
 * @param {CognitoEmailEvent} event
 * @param {string} secret
 * @returns {{subject:string, text:string, html:string}}
 */
export function messageForEvent(event, secret) {
  const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
  const environment = requiredEnvironment("ENVIRONMENT");
  const contact = requiredEnvironment("SETUP_CODE_EMAIL_FROM");
  const username = event.userName;

  if (event.triggerSource === "CustomEmailSender_AdminCreateUser") {
    if (!secret) throw new Error("Missing Cognito temporary password");
    const adminUrl = requiredEnvironment("ADMIN_APP_URL");
    const subject = `${prefix}Your Good Neighbor compliance app invitation`;
    const text = `You have been invited to the Good Neighbor compliance app (${environment}).\n\nUsername: ${username}\nTemporary password: ${secret}\n\nSign in at ${adminUrl} and choose a new password. You will also be asked to set up an authenticator app.\n\nThis invitation expires in 7 days.\n\nAny questions? Contact the Good Neighbor app team at ${contact}.\n\nThanks!\n\nThe Good Neighbor app team`;
    const html = `<p>You have been invited to the Good Neighbor compliance app (${escapeHtml(environment)}).</p><p>Username: ${escapeHtml(username)}<br>Temporary password: ${escapeHtml(secret)}</p><p>Sign in at <a href="${escapeHtml(adminUrl)}">${escapeHtml(adminUrl)}</a> and choose a new password. You will also be asked to set up an authenticator app.</p><p>This invitation expires in 7 days.</p><p>Any questions? Contact the Good Neighbor app team at <a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>.</p><p>Thanks!</p><p>The Good Neighbor app team</p>`;
    return { subject, text, html };
  }

  if (event.triggerSource === "CustomEmailSender_AccountTakeOverNotification") {
    const subject = `${prefix}Important Good Neighbor account security notice`;
    const text = `Amazon Cognito detected potentially suspicious activity on your Good Neighbor compliance app account. If this was not you, contact the Good Neighbor app team immediately at ${contact}.`;
    return { subject, text, html: `<p>${escapeHtml(text)}</p>` };
  }

  if (!secret) throw new Error("Missing Cognito verification code");
  const authentication =
    event.triggerSource === "CustomEmailSender_Authentication";
  const allowed = new Set([
    "CustomEmailSender_SignUp",
    "CustomEmailSender_ResendCode",
    "CustomEmailSender_ForgotPassword",
    "CustomEmailSender_UpdateUserAttribute",
    "CustomEmailSender_VerifyUserAttribute",
    "CustomEmailSender_Authentication",
  ]);
  if (!allowed.has(event.triggerSource)) throw new Error("Unsupported trigger");
  const purpose = authentication ? "sign-in" : "verification";
  const subject = authentication
    ? "Your sign-in code"
    : "Your verification code";
  const text = `Your ${purpose} code is ${secret}.`;
  return {
    subject,
    text,
    html: `<p>Your ${purpose} code is <strong>${escapeHtml(secret)}</strong>.</p>`,
  };
}

/**
 * @param {string} ciphertext
 * @param {string} poolId
 * @returns {Promise<string>}
 */
async function decryptSecret(ciphertext, poolId) {
  const keyArn = requiredEnvironment("COGNITO_EMAIL_KMS_KEY_ARN");
  const keyring = new KmsKeyringNode({
    generatorKeyId: keyArn,
    keyIds: [keyArn],
  });
  const { plaintext, messageHeader } = await decrypt(
    keyring,
    Buffer.from(ciphertext, "base64"),
  );
  if (messageHeader.encryptionContext["userpool-id"] !== poolId) {
    throw new Error("Unexpected Cognito encryption context");
  }
  return Buffer.from(plaintext).toString("utf8");
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeCognitoPassword(value) {
  return value.replace(/&(?:lt|gt|amp|quot|#39);/g, (entity) => {
    switch (entity) {
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&amp;":
        return "&";
      case "&quot;":
        return '"';
      case "&#39;":
        return "'";
      default:
        return entity;
    }
  });
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
