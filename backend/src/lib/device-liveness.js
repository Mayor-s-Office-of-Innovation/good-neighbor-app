// Device-level liveness: the checks every path that trusts a DEVICE# (or
// DEVICE_BINDING#) item applies before honoring it — the authorizer on every
// uncached request, the refresh rotation, and the session handoff redemption
// (docs/adr/0010, docs/adr/0015). Pure: no I/O, no token claims. The
// token-specific comparisons (generation, access level, refresh jti) stay with
// their callers; Site and membership generation rechecks need reads and live
// in handlers/devices.js (`bindingLifecycleValid`).

export const DEFAULT_INACTIVITY_LIMIT_DAYS = 60;

/**
 * @typedef {"missing"|"revoked"|"suspended"|"expired"|"inactive"} DeviceLivenessProblem
 */

/**
 * Why this device item must not be trusted right now, or null when it may.
 * Legacy setup-code devices carry no `status`; absence is treated as active,
 * matching the authorizer's historical behavior.
 * @param {Record<string, any> | undefined | null} device
 * @param {Date} [now]
 * @returns {DeviceLivenessProblem | null}
 */
export function deviceLivenessProblem(device, now = new Date()) {
  if (!device) return "missing";
  if (device.status === "revoked") return "revoked";
  if (device.status === "suspended") return "suspended";
  if (
    device.absoluteExpiresAt &&
    device.absoluteExpiresAt <= now.toISOString()
  ) {
    return "expired";
  }
  const inactiveAfter = device.lastSeenAt
    ? new Date(device.lastSeenAt).getTime() +
      Number(device.inactivityLimitDays ?? DEFAULT_INACTIVITY_LIMIT_DAYS) *
        24 *
        60 *
        60 *
        1000
    : Number.POSITIVE_INFINITY;
  if (inactiveAfter <= now.getTime()) return "inactive";
  return null;
}
