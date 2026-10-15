import { URLSearchParams } from "node:url";
import { createHash } from "node:crypto";
import { configuredEmailProvider, sendEmail } from "./email-transport.js";

/**
 * @typedef {object} SetupCodeEmail
 * @property {string} to
 * @property {string} siteName
 * @property {string} code
 * @property {string} expiresAt
 * @property {string} appUrl
 */

/**
 * Send through the configured transport, or preview locally. Lambda must never
 * log redeemable codes.
 * @param {SetupCodeEmail} email
 * @returns {Promise<{ provider: "log" | "ses" | "smtp", messageId: string }>}
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
    const response = await sendEmail({
      from,
      to: email.to,
      replyTo,
      subject: `${prefix}Your Good Neighbor setup code`,
      text,
      html,
    });
    console.info(
      JSON.stringify({
        ...metadata,
        provider: response.provider,
        status: "accepted",
        messageId: response.messageId,
      }),
    );
    return response;
  } catch {
    // SDK error messages may contain recipient addresses or request content.
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: configuredEmailProvider(),
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
 * @returns {Promise<{ provider: "log" | "ses" | "smtp", messageId: string }>}
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
    const text = `Hello ${email.managerName},\n\nYou've been assigned as a site manager for ${email.siteName} under the Good Neighbor policy.\n\nThe Good Neighbor app is a website that runs in any smartphone, tablet, or desktop PC/Mac browser. We recommend using it with a mobile device with a cellular connection, like a smartphone.\n\nTo start using your device with the Good Neighbor app, use this one-time link:\n\n${email.enrollmentUrl}\n\nThis link expires ${expires} and enrolls one device for ${email.siteName} only. Do not forward it.\n\nThank you,\n\n- The Good Neighbor app team -`;
    const html = `<p>Hello ${escapeHtml(email.managerName)},</p><p>You've been assigned as a site manager for ${escapeHtml(email.siteName)} under the Good Neighbor policy.</p><p>The Good Neighbor app is a website that runs in any smartphone, tablet, or desktop PC/Mac browser. We recommend using it with a mobile device with a cellular connection, like a smartphone.</p><p>To start using your device with the Good Neighbor app, use this one-time link:</p><p><a href="${escapeHtml(email.enrollmentUrl)}">${escapeHtml(email.enrollmentUrl)}</a></p><p>This link expires ${escapeHtml(expires)} and enrolls one device for ${escapeHtml(email.siteName)} only. Do not forward it.</p><p>Thank you,</p><p>- The Good Neighbor app team -</p>`;
    const response = await sendEmail({
      from,
      to: email.to,
      replyTo,
      subject: `${prefix}Activate your device for use with the Good Neighbor app`,
      text,
      html,
    });
    console.info(
      JSON.stringify({
        ...metadata,
        provider: response.provider,
        status: "accepted",
        messageId: response.messageId,
      }),
    );
    return response;
  } catch {
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: configuredEmailProvider(),
        status: "failed",
      }),
    );
    throw new Error("Manager enrollment email delivery failed");
  }
}

/**
 * Send one provider-wide Manager enrollment link. The active Site set is
 * resolved again at redemption, so the message states the current count but
 * does not enumerate Sites or promise that a stale count will be used.
 * @param {{ to:string, managerName:string, providerName:string, siteCount:number, enrollmentUrl:string, expiresAt:string }} email
 * @returns {Promise<{ provider: "log" | "ses" | "smtp", messageId: string }>}
 */
export async function sendProviderManagerEnrollmentEmail(email) {
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localPreview = !isLambda && Boolean(process.env.LOCAL_API_PORT);
  const metadata = {
    marker: "provider_manager_enrollment_email",
    contactHash: createHash("sha256")
      .update(email.to.trim().toLowerCase())
      .digest("hex"),
    providerName: email.providerName,
    siteCount: email.siteCount,
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
    const expires = managerExpiry(email.expiresAt);
    const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
    const replyTo = process.env.SETUP_CODE_EMAIL_REPLY_TO;
    const sites = `${email.siteCount} active ${email.siteCount === 1 ? "Site" : "Sites"}`;
    const text = `Hello ${email.managerName},\n\nYou've been assigned as a manager for ${email.providerName} under the Good Neighbor policy. At the time this invitation was issued, the Provider had ${sites}. The active Site set will be verified when you redeem the link.\n\nThe Good Neighbor app is a website that runs in any smartphone, tablet, or desktop PC/Mac browser. We recommend using it with a mobile device with a cellular connection, like a smartphone.\n\nTo start using your device with the Good Neighbor app, use this one-time link:\n\n${email.enrollmentUrl}\n\nThis link expires ${expires} and enrolls one device as a manager for ${email.providerName} only. Do not forward it.\n\nThank you,\n\n- The Good Neighbor app team -`;
    const html = `<p>Hello ${escapeHtml(email.managerName)},</p><p>You've been assigned as a manager for ${escapeHtml(email.providerName)} under the Good Neighbor policy. At the time this invitation was issued, the Provider had ${escapeHtml(sites)}. The active Site set will be verified when you redeem the link.</p><p>The Good Neighbor app is a website that runs in any smartphone, tablet, or desktop PC/Mac browser. We recommend using it with a mobile device with a cellular connection, like a smartphone.</p><p>To start using your device with the Good Neighbor app, use this one-time link:</p><p><a href="${escapeHtml(email.enrollmentUrl)}">${escapeHtml(email.enrollmentUrl)}</a></p><p>This link expires ${escapeHtml(expires)} and enrolls one device as a manager for ${escapeHtml(email.providerName)} only. Do not forward it.</p><p>Thank you,</p><p>- The Good Neighbor app team -</p>`;
    const response = await sendEmail({
      from,
      to: email.to,
      replyTo,
      subject: `${prefix}Activate your device for use with the Good Neighbor app`,
      text,
      html,
    });
    console.info(
      JSON.stringify({
        ...metadata,
        provider: response.provider,
        status: "accepted",
        messageId: response.messageId,
      }),
    );
    return response;
  } catch {
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: configuredEmailProvider(),
        status: "failed",
      }),
    );
    throw new Error("Provider Manager enrollment email delivery failed");
  }
}

/**
 * Send one recovery message containing separate single-Site Manager links.
 * @param {{ to: string, managerName: string, links: Array<{siteName:string, enrollmentUrl:string, expiresAt:string}> }} email
 * @returns {Promise<{ provider: "log" | "ses" | "smtp", messageId: string }>}
 */
export async function sendManagerAccessEmail(email) {
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localPreview = !isLambda && Boolean(process.env.LOCAL_API_PORT);
  const contactHash = createHash("sha256")
    .update(email.to.trim().toLowerCase())
    .digest("hex");
  const metadata = {
    marker: "manager_access_email",
    contactHash,
    siteCount: email.links.length,
  };
  if (localPreview) {
    const messageId = `local-${Date.now()}`;
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "log",
        status: "preview",
        messageId,
        localOpenUrls: email.links.map((link) => link.enrollmentUrl),
      }),
    );
    return { provider: "log", messageId };
  }
  try {
    const from = process.env.SETUP_CODE_EMAIL_FROM;
    if (!from) throw new Error("Missing email sender");
    for (const link of email.links) {
      const url = new URL(link.enrollmentUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new Error("Invalid enrollment URL");
      }
    }
    const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
    const replyTo = process.env.SETUP_CODE_EMAIL_REPLY_TO;
    const lines = email.links.map(
      (link) =>
        `${link.siteName}: ${link.enrollmentUrl}\nExpires ${managerExpiry(link.expiresAt)}`,
    );
    const text = `Hello ${email.managerName},\n\nUse the applicable one-time link below to enroll this device as a Site Manager. Each link enrolls one Site only.\n\n${lines.join("\n\n")}\n\nDo not forward these links. If you did not request access, contact the City administrator.`;
    const htmlLinks = email.links
      .map(
        (link) =>
          `<li><strong>${escapeHtml(link.siteName)}</strong>: <a href="${escapeHtml(link.enrollmentUrl)}">Enroll this Site</a><br>Expires ${escapeHtml(managerExpiry(link.expiresAt))}</li>`,
      )
      .join("");
    const html = `<p>Hello ${escapeHtml(email.managerName)},</p><p>Use the applicable one-time link below to enroll this device as a Site Manager. Each link enrolls one Site only.</p><ul>${htmlLinks}</ul><p>Do not forward these links. If you did not request access, contact the City administrator.</p>`;
    const response = await sendEmail({
      from,
      to: email.to,
      replyTo,
      subject: `${prefix}Your Good Neighbor Site Manager access`,
      text,
      html,
    });
    console.info(
      JSON.stringify({
        ...metadata,
        provider: response.provider,
        status: "accepted",
        messageId: response.messageId,
      }),
    );
    return response;
  } catch {
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: configuredEmailProvider(),
        status: "failed",
      }),
    );
    throw new Error("Manager access email delivery failed");
  }
}

/**
 * Notify a Manager after a new device binding is enrolled. This message never
 * contains an enrollment credential or access token.
 * @param {{ to:string, managerName:string, siteName:string, deviceLabel:string, clientDescription:string, enrolledAt:string, revocationContact?:string }} email
 * @returns {Promise<{ provider: "log" | "ses" | "smtp", messageId: string }>}
 */
export async function sendManagerSecurityNotification(email) {
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localPreview = !isLambda && Boolean(process.env.LOCAL_API_PORT);
  const metadata = {
    marker: "manager_security_notification_email",
    contactHash: createHash("sha256")
      .update(email.to.trim().toLowerCase())
      .digest("hex"),
    siteName: email.siteName,
  };
  if (localPreview) {
    const messageId = `local-${Date.now()}`;
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "log",
        status: "preview",
        messageId,
      }),
    );
    return { provider: "log", messageId };
  }
  try {
    const from = process.env.SETUP_CODE_EMAIL_FROM;
    if (!from) throw new Error("Missing email sender");
    const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
    const replyTo = process.env.SETUP_CODE_EMAIL_REPLY_TO;
    const enrolled = managerExpiry(email.enrolledAt);
    const contact = email.revocationContact
      ? `Contact ${email.revocationContact} immediately to revoke this device.`
      : "Contact your funding department's program manager immediately to revoke this device.";
    const text = `Hello ${email.managerName},\n\nA device was enrolled as a Good Neighbor Site Manager for ${email.siteName}.\n\nTime: ${enrolled}\nDevice label: ${email.deviceLabel}\nBrowser/device: ${email.clientDescription}\n\nIf this was you, no action is needed. If you do not recognize this enrollment, ${contact}`;
    const html = `<p>Hello ${escapeHtml(email.managerName)},</p><p>A device was enrolled as a Good Neighbor Site Manager for <strong>${escapeHtml(email.siteName)}</strong>.</p><dl><dt>Time</dt><dd>${escapeHtml(enrolled)}</dd><dt>Device label</dt><dd>${escapeHtml(email.deviceLabel)}</dd><dt>Browser/device</dt><dd>${escapeHtml(email.clientDescription)}</dd></dl><p>If this was you, no action is needed. If you do not recognize this enrollment, ${escapeHtml(contact)}</p>`;
    const response = await sendEmail({
      from,
      to: email.to,
      replyTo,
      subject: `${prefix}New Good Neighbor Manager device enrolled`,
      text,
      html,
    });
    console.info(
      JSON.stringify({
        ...metadata,
        provider: response.provider,
        status: "accepted",
        messageId: response.messageId,
      }),
    );
    return response;
  } catch {
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: configuredEmailProvider(),
        status: "failed",
      }),
    );
    throw new Error("Manager security notification delivery failed");
  }
}

/**
 * Notify a Provider Manager after a provider-wide device enrollment. The
 * message deliberately summarizes the scope instead of listing Site names.
 * @param {{ to:string, managerName:string, providerName:string, siteCount:number, deviceLabel:string, clientDescription:string, enrolledAt:string, revocationContact?:string }} email
 * @returns {Promise<{ provider: "log" | "ses" | "smtp", messageId: string }>}
 */
export async function sendProviderManagerSecurityNotification(email) {
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
  const localPreview = !isLambda && Boolean(process.env.LOCAL_API_PORT);
  const metadata = {
    marker: "provider_manager_security_notification_email",
    contactHash: createHash("sha256")
      .update(email.to.trim().toLowerCase())
      .digest("hex"),
    providerName: email.providerName,
    siteCount: email.siteCount,
  };
  if (localPreview) {
    const messageId = `local-${Date.now()}`;
    console.info(
      JSON.stringify({
        ...metadata,
        provider: "log",
        status: "preview",
        messageId,
      }),
    );
    return { provider: "log", messageId };
  }
  try {
    const from = process.env.SETUP_CODE_EMAIL_FROM;
    if (!from) throw new Error("Missing email sender");
    const prefix = process.env.SETUP_CODE_EMAIL_SUBJECT_PREFIX ?? "";
    const replyTo = process.env.SETUP_CODE_EMAIL_REPLY_TO;
    const enrolled = managerExpiry(email.enrolledAt);
    const contact = email.revocationContact
      ? `Contact ${email.revocationContact} immediately to review or revoke this device.`
      : "Contact your City administrator immediately to review or revoke this device.";
    const scope = `${email.siteCount} active ${email.siteCount === 1 ? "Site" : "Sites"}`;
    const text = `Hello ${email.managerName},\n\nA device was enrolled as a Good Neighbor Provider Manager for ${email.providerName}, with access to ${scope}.\n\nTime: ${enrolled}\nDevice label: ${email.deviceLabel}\nBrowser/device: ${email.clientDescription}\n\nIf this was you, no action is needed. If you do not recognize this enrollment, ${contact}`;
    const html = `<p>Hello ${escapeHtml(email.managerName)},</p><p>A device was enrolled as a Good Neighbor Provider Manager for <strong>${escapeHtml(email.providerName)}</strong>, with access to ${escapeHtml(scope)}.</p><dl><dt>Time</dt><dd>${escapeHtml(enrolled)}</dd><dt>Device label</dt><dd>${escapeHtml(email.deviceLabel)}</dd><dt>Browser/device</dt><dd>${escapeHtml(email.clientDescription)}</dd></dl><p>If this was you, no action is needed. If you do not recognize this enrollment, ${escapeHtml(contact)}</p>`;
    const response = await sendEmail({
      from,
      to: email.to,
      replyTo,
      subject: `${prefix}New Good Neighbor Provider Manager device enrolled`,
      text,
      html,
    });
    console.info(
      JSON.stringify({
        ...metadata,
        provider: response.provider,
        status: "accepted",
        messageId: response.messageId,
      }),
    );
    return response;
  } catch {
    console.error(
      JSON.stringify({
        ...metadata,
        level: "ERROR",
        provider: configuredEmailProvider(),
        status: "failed",
      }),
    );
    throw new Error("Provider Manager security notification failed");
  }
}

/** @param {string} value */
function managerExpiry(value) {
  return new Date(value).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "short",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
