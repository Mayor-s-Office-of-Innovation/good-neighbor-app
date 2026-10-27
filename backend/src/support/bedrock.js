import { createHash, createHmac } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
// Native crypto supplies hashes/HMAC, but not AWS SigV4 canonicalization and
// request signing. Use AWS's maintained signer for direct Bedrock HTTPS calls.
import { SignatureV4 } from "@smithy/signature-v4";

/** Native SHA-256 adapter for the AWS-maintained SigV4 signer. */
class Sha256 {
  /** @param {string | ArrayBuffer | ArrayBufferView} [secret] */
  constructor(secret) {
    this.hash = secret
      ? createHmac("sha256", bytes(secret))
      : createHash("sha256");
  }
  /** @param {string | ArrayBuffer | ArrayBufferView} data */
  update(data) {
    this.hash.update(bytes(data));
  }
  async digest() {
    return this.hash.digest();
  }
}

/** @param {string | ArrayBuffer | ArrayBufferView} data */
function bytes(data) {
  if (typeof data === "string") return Buffer.from(data);
  return globalThis.ArrayBuffer.isView(data)
    ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    : Buffer.from(data);
}

// A local support profile must not change credentials used by the emulators.
// Deployed Lambdas leave this unset and use their execution role.
const supportProfile = process.env.SUPPORT_AWS_PROFILE?.trim();
const credentials = defaultProvider(
  supportProfile ? { profile: supportProfile } : {},
);

/**
 * No SDK retries: one deadline includes credentials, privacy check and inference.
 * No provider response bodies or exception messages are logged.
 * @param {{region:string, modelId:string, payload:unknown, signal:AbortSignal}} input
 */
export async function converse({ region, modelId, payload, signal }) {
  const signer = new SignatureV4({
    credentials,
    region,
    service: "bedrock",
    sha256: Sha256,
  });
  /** @param {string} host @param {string} path @param {string} method @param {unknown} [data] */
  async function call(host, path, method, data) {
    signal.throwIfAborted();
    const signed = await signer.sign({
      protocol: "https:",
      hostname: host,
      path,
      method,
      headers: { host, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    signal.throwIfAborted();
    const response = await fetch(`https://${host}${path}`, {
      method,
      headers: signed.headers,
      body: signed.body,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("support_provider_unavailable");
    }
    return response.json();
  }
  // Regional invocation logging can retain full questions/answers. Fail closed
  // if it is enabled or the configuration cannot be verified. No user text is
  // sent on this control-plane call; do not cache an earlier privacy verdict.
  const logging = await call(
    `bedrock.${region}.amazonaws.com`,
    "/logging/modelinvocations",
    "GET",
  );
  if (
    !logging ||
    typeof logging !== "object" ||
    Array.isArray(logging) ||
    (logging.loggingConfig &&
      logging.loggingConfig.textDataDeliveryEnabled !== false)
  ) {
    throw new Error("support_logging_enabled");
  }
  return call(
    `bedrock-runtime.${region}.amazonaws.com`,
    `/model/${encodeURIComponent(modelId)}/converse`,
    "POST",
    payload,
  );
}
