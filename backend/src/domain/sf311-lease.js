/** An expired lease is safe only after the worker's maximum runtime has passed.
 * Compare the observed lease as well, so a new owner cannot slip through.
 * @param {Record<string, any> | undefined} lock
 * @param {string} now
 */
export function inactiveSf311Lease(lock, now) {
  if (!lock?.sf311Lease)
    return {
      ConditionExpression: "attribute_not_exists(sf311Lease)",
      ExpressionAttributeValues: {},
    };
  const expires = lock.sf311LeaseExpiresAt;
  if (
    typeof expires !== "string" ||
    !Number.isFinite(Date.parse(expires)) ||
    new Date(expires).toISOString() !== expires ||
    expires >= now
  )
    return null;
  return {
    ConditionExpression:
      "(attribute_not_exists(sf311Lease) OR (sf311Lease = :observedLease AND sf311LeaseExpiresAt = :leaseExpires AND sf311LeaseExpiresAt < :leaseNow))",
    ExpressionAttributeValues: {
      ":observedLease": lock.sf311Lease,
      ":leaseExpires": expires,
      ":leaseNow": now,
    },
  };
}
