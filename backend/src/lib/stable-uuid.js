// Deterministic UUIDs (RFC 4122 version 5 layout, SHA-1 over a fixed
// namespace plus a name). Used to give queued telemetry a stable event
// identity across SQS redeliveries: the same message and position always
// yields the same uuid, so PostHog can collapse a retried batch instead of
// counting it twice. Not a secret or a random id; never use it for tokens.

import { createHash } from "node:crypto";

/** Fixed namespace for this app's event ids. Changing it changes every uuid. */
const NAMESPACE = Buffer.from("3b7f0a9c4d5e4f60a1b2c3d4e5f60718", "hex");

/**
 * @param {string} name
 * @returns {string} lower-case hyphenated uuid
 */
export function stableUuid(name) {
  const hash = createHash("sha1")
    .update(NAMESPACE)
    .update(String(name), "utf8")
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
